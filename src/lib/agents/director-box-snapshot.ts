/**
 * director-coach-canonical-box-snapshot Phase 1 — a typed, single-shot snapshot of the box state for the
 * director coach turn prompt. The director narrates from THIS payload, not from memory of the `agent_jobs`
 * status enum or hand-rolled SQL.
 *
 * Why this exists (the recurring failure mode): under CEO pressure the coach has filtered `agent_jobs` on
 *   status in ('queued','running','in_progress','needs_attention')
 * — but `running` and `in_progress` aren't in the enum (see docs/brain/tables/agent_jobs.md). The query
 * returns nothing → "box is empty" is reported. The other half: doubling down by reading
 * `director_activity` for pass cadence — but director_activity only logs WRITE actions, not run cadence,
 * so "no platform passes in 4 hours" is reported when there have been several. This module is the
 * structural fix: one query against the REAL enum, plus the real pass-cadence source (agent_jobs
 * `kind='platform-director'`), plus the parked-by-class buckets, plus the active directive, plus my
 * recent WRITE actions. The coach reads from it; the worker also runs a cheap post-reply sanity guard
 * comparing reply text against this payload (Phase 2).
 *
 * Canonical status sets (`BOX_ACTIVE_STATUSES` / `BOX_PARKED_STATUSES` / `BOX_TERMINAL_STATUSES`) are
 * exported so Phase 3 can replace ad-hoc enum lists in src/lib/agents/* with one source of truth.
 *
 * Tests: src/lib/agents/director-box-snapshot.test.ts exercises the pure bucketizers (`bucketizeJobs`,
 * `groupParkedByClass`) against one row per status — no DB needed.
 *
 * See docs/brain/specs/director-coach-canonical-box-snapshot.md · docs/brain/libraries/director-box-snapshot.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveDirective, type DirectorDirective } from "@/lib/agents/director-directives";

type Admin = ReturnType<typeof createAdminClient>;

// ── Canonical status sets ────────────────────────────────────────────────────────────────────────
/**
 * "Active" = the build is still in the queue's hands. Pulled straight from the `status` enum in
 * docs/brain/tables/agent_jobs.md (`queued` → `building` → `completed`, pauses at `needs_input`/
 * `needs_approval` → `queued_resume`, parks at `blocked_on_usage`). `running` and `in_progress` are
 * NOT in the enum — including them is the very bug this spec exists to prevent.
 *
 * `claimed` is the transient state set by `claim_agent_job()` between the SELECT and the flip to
 * `building`; in practice it's never observed at read time but we include it so the bucketizer doesn't
 * silently drop a row caught mid-claim.
 */
export const BOX_ACTIVE_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "blocked_on_usage",
] as const;

/**
 * "Parked" = the job is no longer being driven by the queue but is still on the board — either awaiting
 * a CEO decision (`needs_attention`), cancelled out-of-order by the milestone sequencer (`held`), or
 * dismissed by the spec's owning director (`dismissed`). Distinct from terminal `completed`/`failed`.
 */
export const BOX_PARKED_STATUSES = [
  "needs_attention",
  "held",
  "dismissed",
] as const;

/** Terminal = the job finished one way or the other; used to bound recent completed/failed scans. */
export const BOX_TERMINAL_STATUSES = ["completed", "failed"] as const;

export type BoxActiveStatus = (typeof BOX_ACTIVE_STATUSES)[number];
export type BoxParkedStatus = (typeof BOX_PARKED_STATUSES)[number];
export type BoxTerminalStatus = (typeof BOX_TERMINAL_STATUSES)[number];
export type BoxStatus = BoxActiveStatus | BoxParkedStatus | BoxTerminalStatus;

const RECENT_TERMINAL_WINDOW_MS = 2 * 60 * 60 * 1000; // 2h — recent completed/failed window
const SAMPLE_PER_STATUS = 3;
const RECENT_DIRECTOR_PASSES = 10;
const RECENT_DIRECTOR_WRITES = 10;
const PARKED_SAMPLE_PER_CLASS = 5;
const JOB_QUERY_LIMIT = 500;
const CRITICAL_QUERY_LIMIT = 200;

// ── Public payload shapes ────────────────────────────────────────────────────────────────────────

export interface JobSample {
  id: string;
  spec_slug: string | null;
  kind: string;
  status: BoxStatus;
  needs_attention_class: string | null;
  updated_at: string;
  age_minutes: number;
}

export interface JobBuckets {
  /** count per known status; statuses with no rows are present as 0 so the prompt can read them safely. */
  counts: Record<BoxStatus, number>;
  /** up to SAMPLE_PER_STATUS most-recent rows per status (newest first). */
  samples: Record<BoxStatus, JobSample[]>;
}

export interface DirectorPass {
  id: string;
  spec_slug: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface ParkedClassBucket {
  class_name: string; // 'unclassified' when needs_attention_class is null/empty
  count: number;
  sample: Array<{ slug: string | null; age_minutes: number; updated_at: string }>;
}

export interface DirectorWrite {
  id: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string;
  created_at: string;
}

export interface ActiveDirectiveSnapshot extends DirectorDirective {
  /** minutes since `created_at` at snapshot time (rounded). */
  age_minutes: number;
  /** spec slugs currently carrying **Priority:** critical (spec_card_state.flags.critical=true). */
  critical_specs: string[];
}

export interface DirectorBoxSnapshot {
  workspace_id: string;
  director_function: string;
  generated_at: string;
  jobs: JobBuckets;
  recentDirectorPasses: DirectorPass[];
  parkedByClass: ParkedClassBucket[];
  activeDirective: ActiveDirectiveSnapshot | null;
  recentDirectorWrites: DirectorWrite[];
}

// ── Pure bucketizers (the unit-test surface) ─────────────────────────────────────────────────────

export interface RawJobRow {
  id: string;
  spec_slug: string | null;
  kind: string | null;
  status: string | null;
  needs_attention_class: string | null;
  updated_at: string | null;
  created_at: string | null;
  completed_at?: string | null;
  error?: string | null;
}

const ALL_TRACKED_STATUSES = [
  ...BOX_ACTIVE_STATUSES,
  ...BOX_PARKED_STATUSES,
  ...BOX_TERMINAL_STATUSES,
] as const satisfies readonly BoxStatus[];

const KNOWN_ACTIVE = new Set<string>(BOX_ACTIVE_STATUSES);
const KNOWN_PARKED = new Set<string>(BOX_PARKED_STATUSES);
const KNOWN_TERMINAL = new Set<string>(BOX_TERMINAL_STATUSES);

function ageMinutesFrom(iso: string | null | undefined, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((now - t) / 60_000));
}

function emptyCounts(): Record<BoxStatus, number> {
  const c = {} as Record<BoxStatus, number>;
  for (const s of ALL_TRACKED_STATUSES) c[s] = 0;
  return c;
}

function emptySamples(): Record<BoxStatus, JobSample[]> {
  const s = {} as Record<BoxStatus, JobSample[]>;
  for (const k of ALL_TRACKED_STATUSES) s[k] = [];
  return s;
}

/**
 * Group raw `agent_jobs` rows into the canonical buckets. A status not in any canonical set is dropped
 * so a typo or unknown enum value can't inflate a bucket; counts surface only the statuses we know about
 * (and every known status is present — zero by default — so the prompt reads "needs_attention: 0" safely,
 * which is exactly the misread the spec exists to prevent).
 *
 * Terminal rows (`completed`/`failed`) are included only if their most recent timestamp falls within the
 * 2h window; active/parked rows are included regardless of age.
 */
export function bucketizeJobs(rows: RawJobRow[], now: number): JobBuckets {
  const counts = emptyCounts();
  const samples = emptySamples();

  for (const r of rows) {
    const status = r.status ?? "";
    const isActive = KNOWN_ACTIVE.has(status);
    const isParked = KNOWN_PARKED.has(status);
    const isTerminal = KNOWN_TERMINAL.has(status);
    if (!isActive && !isParked && !isTerminal) continue;

    if (isTerminal) {
      const tIso = r.updated_at ?? r.completed_at ?? r.created_at ?? "";
      const t = Date.parse(tIso);
      if (!Number.isFinite(t) || now - t > RECENT_TERMINAL_WINDOW_MS) continue;
    }

    const s = status as BoxStatus;
    counts[s] = (counts[s] ?? 0) + 1;
    if (samples[s].length < SAMPLE_PER_STATUS) {
      samples[s].push({
        id: r.id,
        spec_slug: r.spec_slug,
        kind: r.kind ?? "",
        status: s,
        needs_attention_class: r.needs_attention_class,
        updated_at: r.updated_at ?? r.created_at ?? "",
        age_minutes: ageMinutesFrom(r.updated_at ?? r.created_at, now),
      });
    }
  }
  return { counts, samples };
}

/**
 * Group `needs_attention` rows by their `needs_attention_class` (the auto-router's dispatch field).
 * NULL/empty classes collapse to `'unclassified'`. Returns largest classes first (then alpha) so the
 * prompt's bullet list is stable + reads top-down by impact.
 */
export function groupParkedByClass(rows: RawJobRow[], now: number): ParkedClassBucket[] {
  const map = new Map<string, ParkedClassBucket>();
  for (const r of rows) {
    if (r.status !== "needs_attention") continue;
    const key = (r.needs_attention_class ?? "").trim() || "unclassified";
    let b = map.get(key);
    if (!b) {
      b = { class_name: key, count: 0, sample: [] };
      map.set(key, b);
    }
    b.count++;
    if (b.sample.length < PARKED_SAMPLE_PER_CLASS) {
      b.sample.push({
        slug: r.spec_slug,
        age_minutes: ageMinutesFrom(r.updated_at ?? r.created_at, now),
        updated_at: r.updated_at ?? r.created_at ?? "",
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.class_name.localeCompare(b.class_name),
  );
}

// ── DB-backed snapshot (the public entry point) ──────────────────────────────────────────────────

/**
 * Get the full box snapshot for a director's coach turn. Bootstraps via `createAdminClient()` (service
 * role — CLAUDE.md invariant). Best-effort: any branch that fails yields its empty shape rather than
 * throwing, so a transient read never blocks the coach turn.
 */
export async function getDirectorBoxSnapshot(
  workspaceId: string,
  directorFunction: string,
): Promise<DirectorBoxSnapshot> {
  const admin = createAdminClient();
  const now = Date.now();
  const rows = await readJobRows(admin, workspaceId, now);
  const jobs = bucketizeJobs(rows, now);
  const parkedByClass = groupParkedByClass(rows, now);
  const [recentDirectorPasses, activeDirective, recentDirectorWrites] = await Promise.all([
    readDirectorPasses(admin, workspaceId),
    readActiveDirective(admin, workspaceId, directorFunction, now),
    readRecentDirectorWrites(admin, workspaceId, directorFunction),
  ]);
  return {
    workspace_id: workspaceId,
    director_function: directorFunction,
    generated_at: new Date(now).toISOString(),
    jobs,
    recentDirectorPasses,
    parkedByClass,
    activeDirective,
    recentDirectorWrites,
  };
}

async function readJobRows(admin: Admin, workspaceId: string, now: number): Promise<RawJobRow[]> {
  try {
    const recentCutoff = new Date(now - RECENT_TERMINAL_WINDOW_MS).toISOString();
    // Active + parked rows of any age, plus terminal rows updated in the last 2h. Two queries are easier
    // to reason about than a hand-built `.or(...)` AND-of-ORs string and keep PostgREST happy.
    const activeParked = [...BOX_ACTIVE_STATUSES, ...BOX_PARKED_STATUSES];
    const [{ data: a }, { data: t }] = await Promise.all([
      admin
        .from("agent_jobs")
        .select("id, spec_slug, kind, status, needs_attention_class, updated_at, created_at, completed_at, error")
        .eq("workspace_id", workspaceId)
        .in("status", activeParked)
        .order("updated_at", { ascending: false })
        .limit(JOB_QUERY_LIMIT),
      admin
        .from("agent_jobs")
        .select("id, spec_slug, kind, status, needs_attention_class, updated_at, created_at, completed_at, error")
        .eq("workspace_id", workspaceId)
        .in("status", BOX_TERMINAL_STATUSES as unknown as string[])
        .gte("updated_at", recentCutoff)
        .order("updated_at", { ascending: false })
        .limit(JOB_QUERY_LIMIT),
    ]);
    return [...((a ?? []) as RawJobRow[]), ...((t ?? []) as RawJobRow[])];
  } catch {
    return [];
  }
}

async function readDirectorPasses(admin: Admin, workspaceId: string): Promise<DirectorPass[]> {
  try {
    // `platform-director` is the standing-pass kind; pass cadence MUST come from agent_jobs (the runs)
    // not director_activity (the writes). See the spec's "why" — the wrong source was the second misread.
    const { data } = await admin
      .from("agent_jobs")
      .select("id, spec_slug, status, created_at, completed_at, error")
      .eq("workspace_id", workspaceId)
      .eq("kind", "platform-director")
      .order("created_at", { ascending: false })
      .limit(RECENT_DIRECTOR_PASSES);
    return ((data ?? []) as DirectorPass[]).map((r) => ({
      id: r.id,
      spec_slug: r.spec_slug,
      status: r.status,
      created_at: r.created_at,
      completed_at: r.completed_at,
      error: r.error,
    }));
  } catch {
    return [];
  }
}

async function readActiveDirective(
  admin: Admin,
  workspaceId: string,
  directorFunction: string,
  now: number,
): Promise<ActiveDirectiveSnapshot | null> {
  try {
    const directive = await getActiveDirective(admin, workspaceId, directorFunction);
    if (!directive) return null;
    const { data: critRows } = await admin
      .from("spec_card_state")
      .select("spec_slug, flags")
      .eq("workspace_id", workspaceId)
      .eq("flags->>critical", "true")
      .limit(CRITICAL_QUERY_LIMIT);
    const critical_specs = ((critRows ?? []) as { spec_slug: string }[]).map((r) => r.spec_slug);
    return {
      ...directive,
      age_minutes: ageMinutesFrom(directive.created_at, now),
      critical_specs,
    };
  } catch {
    return null;
  }
}

async function readRecentDirectorWrites(
  admin: Admin,
  workspaceId: string,
  directorFunction: string,
): Promise<DirectorWrite[]> {
  try {
    const { data } = await admin
      .from("director_activity")
      .select("id, action_kind, spec_slug, reason, created_at")
      .eq("workspace_id", workspaceId)
      .eq("director_function", directorFunction)
      .order("created_at", { ascending: false })
      .limit(RECENT_DIRECTOR_WRITES);
    return ((data ?? []) as DirectorWrite[]).map((r) => ({
      id: r.id,
      action_kind: r.action_kind,
      spec_slug: r.spec_slug,
      reason: r.reason,
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}
