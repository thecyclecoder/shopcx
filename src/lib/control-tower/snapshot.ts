/**
 * Control Tower snapshot consumer — shapes the `public.control_tower_snapshot(uuid)` RPC's jsonb
 * payload into the panel types the /api/developer/control-tower route already returns.
 *
 * Phase 3 of docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md. The route used to fire
 * ~10-15 DB SELECTs per ~15s tick (getDbHealthPanel + getOpenRepairs + getDirectorDismissedRepairs
 * + getOpenCoverageRegistrations + getOpenSpecDrift + getClaudeHealth), each with its own PostgREST
 * set_config preamble. `getControlTowerDbPanels` collapses all six into ONE `admin.rpc` call and
 * shapes the raw rows into the same panel types.
 *
 * The pre-existing helpers stay — they are consumed by other surfaces (platform-director reads
 * `getOpenRepairs`; the Claude poll cron reads `getClaudeHealth`). This module is a NEW parallel
 * consumer that shares the payload contract, not a replacement for those callers.
 *
 * Brain: docs/brain/libraries/control-tower.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { DbHealthPanel, DbHealthProposalItem, DbHealthSlowQuery, DbHealthTopTable } from "@/lib/control-tower/db-health";
import type { RepairSurfaceItem, DirectorDismissedRepairItem } from "@/lib/repair-agent";
import type { CoverageRegisterItem } from "@/lib/coverage-register-agent";
import { COVERAGE_REGISTER_SLUG_PREFIX, type InferredLoopEntry } from "@/lib/coverage-register-agent";
import type { SpecDriftRow } from "@/lib/spec-drift";
import type { ClaudeHealth, ClaudeComponentStatus } from "@/lib/claude-health";
import { LOCAL_FAILURE_THRESHOLD, LOCAL_SIGNAL_TTL_MS } from "@/lib/claude-health";

type Admin = ReturnType<typeof createAdminClient>;
type OwnerFunction = InferredLoopEntry extends { owner: infer O } ? O : never;

// ── Payload types ────────────────────────────────────────────────────────────
// The exact shape the RPC returns per its migration (kept explicit so a schema drift is a compile
// error, not a silent runtime bug).

interface RawTopTable {
  table_name: string;
  total_bytes: number;
  row_estimate: number;
}
interface RawBeat {
  ran_at: string;
  produced: unknown;
}
interface RawAgentJobRow {
  id: string;
  spec_slug: string | null;
  status: string;
  instructions: unknown;
  pending_actions?: unknown;
  log_tail?: unknown;
  created_at: string;
}
interface RawDirectorActivityRow {
  action_kind: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
interface RawClaudeHealthRow {
  api_status: string;
  code_status: string;
  external_down: boolean;
  last_polled_at: string | null;
  poll_ok: boolean | null;
  consecutive_failures: number;
  last_failure_at: string | null;
  breaker_open: boolean;
  tripped_at: string | null;
  recovered_at: string | null;
  detail: string | null;
  updated_at: string | null;
}
interface ControlTowerSnapshotPayload {
  top_tables: RawTopTable[];
  slowq_beat: RawBeat | null;
  size_beat: RawBeat | null;
  db_health_proposals: RawAgentJobRow[];
  repairs: RawAgentJobRow[];
  director_dismissed: RawDirectorActivityRow[];
  coverage_register: RawAgentJobRow[];
  spec_drift: SpecDriftRow[];
  claude_health: RawClaudeHealthRow | null;
}

/** The consolidated panels the /api/developer/control-tower route returns to the page. */
export interface ControlTowerDbPanels {
  dbHealth: DbHealthPanel;
  repairs: RepairSurfaceItem[];
  directorDismissed: DirectorDismissedRepairItem[];
  coverageRegister: CoverageRegisterItem[];
  specDrift: SpecDriftRow[];
  claudeHealth: ClaudeHealth;
}

// ── Shape helpers (mirror the pre-Phase-3 per-helper mapping code) ───────────

const DEFAULT_CLAUDE_HEALTH: ClaudeHealth = {
  apiStatus: "unknown",
  codeStatus: "unknown",
  externalDown: false,
  localDown: false,
  down: false,
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastPolledAt: null,
  pollOk: null,
  trippedAt: null,
  recoveredAt: null,
  detail: null,
  updatedAt: null,
};

function asComponentStatus(s: string | null | undefined): ClaudeComponentStatus {
  switch (s) {
    case "operational":
    case "degraded_performance":
    case "partial_outage":
    case "major_outage":
    case "under_maintenance":
      return s;
    default:
      return "unknown";
  }
}
function isOutageStatus(s: ClaudeComponentStatus): boolean {
  return s === "partial_outage" || s === "major_outage";
}
function localDownFrom(consecutiveFailures: number, lastFailureAt: string | null, now: number): boolean {
  if (consecutiveFailures < LOCAL_FAILURE_THRESHOLD || !lastFailureAt) return false;
  return now - new Date(lastFailureAt).getTime() <= LOCAL_SIGNAL_TTL_MS;
}
function shapeClaudeHealth(row: RawClaudeHealthRow | null): ClaudeHealth {
  if (!row) return DEFAULT_CLAUDE_HEALTH;
  const apiStatus = asComponentStatus(row.api_status);
  const codeStatus = asComponentStatus(row.code_status);
  const externalDown = isOutageStatus(apiStatus) || isOutageStatus(codeStatus);
  const localDown = localDownFrom(row.consecutive_failures ?? 0, row.last_failure_at, Date.now());
  return {
    apiStatus,
    codeStatus,
    externalDown,
    localDown,
    down: externalDown || localDown,
    consecutiveFailures: row.consecutive_failures ?? 0,
    lastFailureAt: row.last_failure_at,
    lastPolledAt: row.last_polled_at,
    pollOk: row.poll_ok,
    trippedAt: row.tripped_at,
    recoveredAt: row.recovered_at,
    detail: row.detail,
    updatedAt: row.updated_at,
  };
}

function shapeDbHealth(payload: ControlTowerSnapshotPayload): DbHealthPanel {
  const topTables: DbHealthTopTable[] = payload.top_tables.map((r) => ({
    table: String(r.table_name ?? ""),
    totalBytes: Number(r.total_bytes ?? 0),
    rowEstimate: Number(r.row_estimate ?? 0),
  }));
  const producedSlow = (payload.slowq_beat?.produced ?? null) as { slow_queries?: unknown } | null;
  const slowQueries: DbHealthSlowQuery[] = Array.isArray(producedSlow?.slow_queries)
    ? (producedSlow!.slow_queries as Array<Record<string, unknown>>).slice(0, 10).map((q) => ({
        queryid: String(q.queryid ?? ""),
        cause: String(q.cause ?? ""),
        table: String(q.table ?? ""),
        impact: String(q.impact ?? ""),
      }))
    : [];
  const proposals: DbHealthProposalItem[] = payload.db_health_proposals.map((row) => {
    let title = String(row.spec_slug || "");
    let impact = "";
    let cause = "";
    let category = "";
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.title) title = String(instr.title);
      impact = String(instr.impact ?? "");
      cause = String(instr.cause ?? "");
      category = String(instr.category ?? "");
    } catch {
      /* not JSON — fall back to the slug */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "db_health_build" && a.status === "pending");
    return {
      jobId: String(row.id),
      signature: String(row.spec_slug || ""),
      title,
      impact: impact || (typeof row.log_tail === "string" ? row.log_tail : ""),
      cause,
      category,
      specSlug: buildAction ? String(buildAction.spec_slug || "") || null : null,
      specTitle: buildAction ? String(buildAction.spec_title || "") || null : null,
      createdAt: String(row.created_at || ""),
    };
  });
  return {
    topTables,
    slowQueries,
    proposals,
    lastSizeSweepAt: payload.size_beat?.ran_at ?? null,
    lastSlowQueryAt: payload.slowq_beat?.ran_at ?? null,
  };
}

function shapeRepairs(rows: RawAgentJobRow[]): RepairSurfaceItem[] {
  return rows.map((row) => {
    let title = String(row.spec_slug || "");
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.title) title = String(instr.title);
    } catch {
      /* instructions not JSON — fall back to the slug */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "repair_build" && a.status === "pending");
    const specSlug = buildAction ? String(buildAction.spec_slug || "") || null : null;
    return {
      jobId: String(row.id),
      signature: String(row.spec_slug || ""),
      title,
      diagnosis: typeof row.log_tail === "string" ? row.log_tail : "",
      specSlug,
      state: row.status === "needs_approval" && specSlug ? "proposed" : "needs-human",
      createdAt: String(row.created_at || ""),
    };
  });
}

function shapeDirectorDismissed(rows: RawDirectorActivityRow[]): DirectorDismissedRepairItem[] {
  // Same dedup+reopen logic as getDirectorDismissedRepairs: gather any 'reopened_repair' job ids
  // first so a later re-open cancels a prior dismissal from the surface. Rows arrive newest-first.
  const reopened = new Set<string>();
  for (const r of rows) {
    if (r.action_kind !== "reopened_repair") continue;
    const jobId = r.metadata?.["repair_job_id"];
    if (typeof jobId === "string") reopened.add(jobId);
  }
  const out: DirectorDismissedRepairItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.action_kind !== "dismissed_repair") continue;
    const meta = r.metadata ?? {};
    const jobId = typeof meta["repair_job_id"] === "string" ? (meta["repair_job_id"] as string) : "";
    if (!jobId || reopened.has(jobId) || seen.has(jobId)) continue;
    seen.add(jobId);
    const signature = typeof meta["signature"] === "string" ? (meta["signature"] as string) : "";
    const title = typeof meta["title"] === "string" && meta["title"] ? (meta["title"] as string) : signature;
    out.push({ jobId, signature, title, reasoning: r.reason ?? "", dismissedAt: r.created_at });
  }
  return out;
}

function shapeCoverageRegister(rows: RawAgentJobRow[]): CoverageRegisterItem[] {
  return rows.map((row) => {
    let loopId = String(row.spec_slug || "").replace(COVERAGE_REGISTER_SLUG_PREFIX, "");
    let cadence = "";
    let proposedOwner: OwnerFunction = "platform" as OwnerFunction;
    let proposedCadence = "";
    let registerSlug = "";
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.loop_id) loopId = String(instr.loop_id);
      if (instr.cadence) cadence = String(instr.cadence);
      if (instr.register_spec_slug) registerSlug = String(instr.register_spec_slug);
      const entry = (instr.entry || {}) as Partial<InferredLoopEntry>;
      if (entry.owner) proposedOwner = entry.owner as OwnerFunction;
      if (entry.expectedCadence) proposedCadence = String(entry.expectedCadence);
    } catch {
      /* instructions not JSON — fall back to the slug */
    }
    return {
      jobId: String(row.id),
      loopId,
      cadence,
      proposedOwner,
      proposedCadence,
      registerSlug,
      createdAt: String(row.created_at || ""),
    };
  });
}

/**
 * READ-ONLY: one round trip → all six raw-SELECT panels the Control Tower page consumes. Falls back
 * to a healthy-default panel set if the RPC read fails — the page still renders (a red tile from
 * the surrounding buildControlTowerSnapshot/buildErrorFeedSnapshot signals the actual outage).
 */
export async function getControlTowerDbPanels(admin: Admin, workspaceId: string): Promise<ControlTowerDbPanels> {
  const empty: ControlTowerDbPanels = {
    dbHealth: { topTables: [], slowQueries: [], proposals: [], lastSizeSweepAt: null, lastSlowQueryAt: null },
    repairs: [],
    directorDismissed: [],
    coverageRegister: [],
    specDrift: [],
    claudeHealth: DEFAULT_CLAUDE_HEALTH,
  };
  const { data, error } = await admin.rpc("control_tower_snapshot", { p_workspace_id: workspaceId });
  if (error || !data) return empty;
  const payload = data as ControlTowerSnapshotPayload;
  return {
    dbHealth: shapeDbHealth(payload),
    repairs: shapeRepairs(payload.repairs ?? []),
    directorDismissed: shapeDirectorDismissed(payload.director_dismissed ?? []),
    coverageRegister: shapeCoverageRegister(payload.coverage_register ?? []),
    specDrift: (payload.spec_drift ?? []) as SpecDriftRow[],
    claudeHealth: shapeClaudeHealth(payload.claude_health),
  };
}
