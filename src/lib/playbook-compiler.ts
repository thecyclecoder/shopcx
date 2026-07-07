/**
 * Playbook compiler — mines the FULL ticket history (tickets + ticket_analyses,
 * no 30-day floor) for recurring problem × resolution "trees" and persists them
 * to [[compiled_trees]] as the durable substrate Phase 2 will read to propose
 * data-grounded playbooks + playbook_steps (is_active=false).
 *
 * Phase 1 of playbook-compiler-becomes-box-agent-mining-full-history:
 * this file used to be a raw-Anthropic-API cron drafting sonnet_prompts rows.
 * That path is GONE — no raw external model API call is made from ShopCX
 * ([[../operational-rules]] § No-Fable-no-raw-API). The compilation is now a
 * supervised **box agent** kind (`playbook-compile` in scripts/builder-worker.ts
 * → `runPlaybookCompileJob`) that reads the brief this module builds, emits a
 * JSON verdict listing trees, and lets the deterministic worker persist them
 * here via `applyBoxPlaybookCompile`. The runner ALSO writes one
 * `director_activity` row (director_function='cs', action_kind=
 * 'compiled_trees_extracted') carrying the agent's reasoning — the CEO/audit
 * trail sees WHAT the compiler decided + WHY.
 *
 * The pure helpers `extractActionTypes`, `bucketClusters`, `treeKeyFor` stay
 * exported so:
 *   (a) the box agent's runner can seed a deterministic tree_key namespace
 *       matching the store's UNIQUE (workspace_id, tree_key) — the agent's
 *       proposed key MUST equal the pure helper's output so re-runs upsert the
 *       same row (idempotent by construction);
 *   (b) the existing unit tests around the clustering shape keep running.
 *
 * Model tier: the box agent is dispatched under the model-tier registry
 * (agent_model_tiers.agent_kind='playbook-compile'). Unset → the Max default;
 * pinned → the registered tier ([[../libraries/agent-model-tiers]]).
 *
 * Idempotency: re-running the box agent over unchanged history returns the same
 * tree_keys → the upsert replaces each row in place, no fan-out. This is the
 * spec's Phase-1 verification bullet ("Re-running over unchanged history is
 * idempotent").
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/** Default support threshold — cluster needs >= this many distinct tickets to
 * qualify for Phase-2 playbook proposal. Kept exported so the box agent's
 * runner can bake the threshold into its brief. */
export const DEFAULT_SUPPORT_MIN = 15;

/** LEGACY export retained for Phase-3-of-the-original-loop test compatibility.
 * The full-history box agent no longer uses a rolling window — it mines every
 * confirmed row + every analysis for the workspace. */
export const MINING_WINDOW_DAYS = 30;

interface ResolutionRow {
  id: string;
  ticket_id: string;
  problem: string | null;
  options: unknown;
  chosen: unknown;
  verified_outcome: string | null;
  staged_at: string;
}

export interface Cluster {
  /** Normalized diagnosis (SonnetDecision.problem, lowercased + trimmed). */
  problem: string;
  /** Sorted action-shape type tuple, e.g. ["partial_refund","replacement"]. */
  actionTypes: string[];
  /** Deterministic per-workspace key `problem :: type_a+type_b` — the store's UNIQUE constraint column. */
  key: string;
  /** Distinct ticket_id count — the "support" of the pattern. */
  support: number;
  /** Sample ticket ids (up to 5) — passed to the agent as evidence. */
  sampleTicketIds: string[];
}

/**
 * Extract the resolution shape from a ticket_resolution_events row.
 *
 * `options` is an array of `{label, action_shape, expected_effect}`;
 * `chosen.option_index` indexes into it. `action_shape` can be a
 * single action-shape object OR an array of them (the orchestrator
 * sometimes bundles a replacement + partial_refund into one option).
 * We return the sorted list of `.type` strings so multi-action shapes
 * cluster on the tuple.
 */
export function extractActionTypes(options: unknown, chosen: unknown): string[] {
  if (!Array.isArray(options)) return [];
  if (!chosen || typeof chosen !== "object") return [];
  const optionIndex = (chosen as { option_index?: unknown }).option_index;
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex)) return [];
  if (optionIndex < 0 || optionIndex >= options.length) return [];
  const picked = options[optionIndex];
  if (!picked || typeof picked !== "object") return [];
  const shape = (picked as { action_shape?: unknown }).action_shape;
  const types: string[] = [];
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;
    const t = (node as { type?: unknown }).type;
    if (typeof t === "string" && t.length > 0) types.push(t);
  };
  walk(shape);
  // Dedupe + stable-sort so `replacement + partial_refund` and
  // `partial_refund + replacement` land in the same cluster.
  return Array.from(new Set(types)).sort();
}

/**
 * Bucket confirmed resolution rows into (problem, actionTypes) clusters.
 *
 * Rows missing problem or with no derivable actionTypes are dropped —
 * they can't participate in a "when X → do Y" tree.
 *
 * Support is counted per-ticket (a two-turn ticket with the same
 * problem×action doesn't double-count) — the pattern is "N distinct
 * tickets landed here", not "N turns".
 */
export function bucketClusters(rows: ResolutionRow[]): Cluster[] {
  const map = new Map<string, {
    problem: string;
    actionTypes: string[];
    tickets: Set<string>;
    samples: string[];
  }>();

  for (const row of rows) {
    const problem = (row.problem || "").trim().toLowerCase();
    if (!problem) continue;
    const actionTypes = extractActionTypes(row.options, row.chosen);
    if (actionTypes.length === 0) continue;
    const key = treeKeyFor(problem, actionTypes);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { problem, actionTypes, tickets: new Set(), samples: [] };
      map.set(key, bucket);
    }
    bucket.tickets.add(row.ticket_id);
    if (bucket.samples.length < 5 && !bucket.samples.includes(row.ticket_id)) {
      bucket.samples.push(row.ticket_id);
    }
  }

  const out: Cluster[] = [];
  for (const [key, bucket] of map) {
    out.push({
      problem: bucket.problem,
      actionTypes: bucket.actionTypes,
      key,
      support: bucket.tickets.size,
      sampleTicketIds: bucket.samples,
    });
  }
  // Highest-support first — the box agent reads the brief top-down, so the
  // hottest patterns anchor its reasoning.
  out.sort((a, b) => b.support - a.support);
  return out;
}

/**
 * Deterministic tree_key builder — the string the box agent must emit as
 * `tree_key` on each verdict tree so the runner's upsert into
 * `compiled_trees` lands on the SAME row as the pure helper's cluster key.
 *
 * Idempotency depends on this: re-running the agent over unchanged history
 * produces the same key → the upsert replaces the row in place, no fan-out.
 */
export function treeKeyFor(problem: string, actionTypes: string[]): string {
  return `${problem.trim().toLowerCase()} :: ${[...actionTypes].sort().join("+")}`;
}

/** Read the per-workspace support threshold if pinned, else the default.
 *  Missing column or missing row → default. Best-effort — a read failure
 *  falls back to the default so the compiler always runs. */
export async function loadSupportMin(admin: SupabaseClient, workspaceId: string): Promise<number> {
  try {
    const { data } = await admin
      .from("workspaces")
      .select("playbook_compiler_support_min")
      .eq("id", workspaceId)
      .maybeSingle();
    const raw = (data as { playbook_compiler_support_min?: unknown } | null)?.playbook_compiler_support_min;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  } catch {
    // column may not exist yet — fall through to default.
  }
  return DEFAULT_SUPPORT_MIN;
}

/** One entry in the intent-distribution the agent surfaces per tree. */
export interface IntentDistributionEntry {
  intent: string;
  ticket_count: number;
}

/** One tree the box agent emits in its verdict, upserted verbatim into `compiled_trees`. */
export interface CompiledTreeVerdict {
  /** MUST equal `treeKeyFor(problem, action_types)` — the store's UNIQUE
   *  constraint anchors idempotency on this. */
  tree_key: string;
  problem: string;
  action_types: string[];
  support: number;
  sample_ticket_ids: string[];
  /** { intent_name: distinct_ticket_count, ... } — Phase 2 will derive
   *  playbook.trigger_intents from the top entries here. */
  intent_distribution: Record<string, number>;
  /** Ordered action shapes the tree resolves via — Phase 2 will materialize
   *  playbook_steps from this. Shape: [{action_type, notes?}, ...]. */
  resolution_sequence: Array<Record<string, unknown>>;
  /** Structured evidence pointers so the compiled row is auditable back to
   *  its source rows (ticket_analyses ids, resolution_event ids, window). */
  evidence: Record<string, unknown>;
  /** 1-2 sentence "why this tree" the runner copies into director_activity. */
  reasoning: string;
}

/** The full verdict the box agent emits — the deterministic runner upserts each
 *  tree into `compiled_trees` and writes ONE director_activity row summarizing. */
export interface PlaybookCompileVerdict {
  trees: CompiledTreeVerdict[];
  /** Overall run reasoning — one paragraph, the CEO/audit trail reads this. */
  reasoning: string;
}

/** Shape guards — the runner defensively normalizes an agent verdict before
 *  writing anything. A malformed verdict lands as `needs_attention` on the job. */
export function normalizePlaybookCompileVerdict(raw: unknown): PlaybookCompileVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const trees: CompiledTreeVerdict[] = [];
  if (Array.isArray(r.trees)) {
    for (const item of r.trees) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const problem = typeof t.problem === "string" ? t.problem.trim().toLowerCase() : "";
      const actionTypesRaw = Array.isArray(t.action_types) ? t.action_types : [];
      const actionTypes = actionTypesRaw
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim());
      if (!problem || actionTypes.length === 0) continue;
      const supportRaw = t.support;
      const support = typeof supportRaw === "number" && Number.isFinite(supportRaw) && supportRaw >= 0 ? Math.floor(supportRaw) : 0;
      const sampleTicketIds = Array.isArray(t.sample_ticket_ids)
        ? (t.sample_ticket_ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20)
        : [];
      const intent_distribution: Record<string, number> = {};
      if (t.intent_distribution && typeof t.intent_distribution === "object" && !Array.isArray(t.intent_distribution)) {
        for (const [k, v] of Object.entries(t.intent_distribution)) {
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) intent_distribution[k] = Math.floor(v);
        }
      }
      const resolution_sequence: Array<Record<string, unknown>> = [];
      if (Array.isArray(t.resolution_sequence)) {
        for (const step of t.resolution_sequence) {
          if (step && typeof step === "object" && !Array.isArray(step)) {
            resolution_sequence.push(step as Record<string, unknown>);
          }
        }
      }
      const evidence: Record<string, unknown> = t.evidence && typeof t.evidence === "object" && !Array.isArray(t.evidence) ? (t.evidence as Record<string, unknown>) : {};
      const reasoning = typeof t.reasoning === "string" ? t.reasoning.slice(0, 2000) : "";
      // The store's UNIQUE constraint anchors on the deterministic key derived
      // from (problem, actionTypes) — the runner recomputes it here so a
      // mis-typed key from the agent never fans a duplicate row.
      const tree_key = treeKeyFor(problem, actionTypes);
      trees.push({
        tree_key,
        problem,
        action_types: actionTypes,
        support,
        sample_ticket_ids: sampleTicketIds,
        intent_distribution,
        resolution_sequence,
        evidence,
        reasoning,
      });
    }
  }
  const reasoning = typeof r.reasoning === "string" ? r.reasoning : "";
  return { trees, reasoning };
}

/** Result of `applyBoxPlaybookCompile` — the runner's summary of what it wrote. */
export interface ApplyPlaybookCompileResult {
  treesUpserted: number;
  reasonSkipped: string[];
}

/**
 * Persist a box-agent verdict — one upsert per tree into `compiled_trees` +
 * ONE `director_activity` row (director_function='cs',
 * action_kind='compiled_trees_extracted') carrying the reasoning.
 *
 * Idempotent: the UNIQUE (workspace_id, tree_key) constraint means re-running
 * over unchanged history no-ops (the upsert replaces the same row).
 *
 * Best-effort: an upsert error on one tree logs + skips it — the sweep never
 * fails because of one bad row. director_activity write is best-effort by
 * design ([[director-activity]] `recordDirectorActivity`).
 */
export async function applyBoxPlaybookCompile(
  admin: SupabaseClient,
  input: {
    workspaceId: string;
    jobId: string | null;
    verdict: PlaybookCompileVerdict;
  },
): Promise<ApplyPlaybookCompileResult> {
  const skipped: string[] = [];
  let upserted = 0;
  for (const tree of input.verdict.trees) {
    const { error } = await admin.from("compiled_trees").upsert(
      {
        workspace_id: input.workspaceId,
        tree_key: tree.tree_key,
        problem: tree.problem,
        action_types: tree.action_types,
        support: tree.support,
        sample_ticket_ids: tree.sample_ticket_ids,
        intent_distribution: tree.intent_distribution,
        resolution_sequence: tree.resolution_sequence,
        evidence: tree.evidence,
        reasoning: tree.reasoning,
        compiled_by_job_id: input.jobId,
        compiled_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,tree_key" },
    );
    if (error) {
      console.warn(`[playbook-compiler] compiled_trees upsert failed (${tree.tree_key}):`, error.message);
      skipped.push(`${tree.tree_key}: ${error.message}`);
      continue;
    }
    upserted++;
  }

  try {
    const { recordDirectorActivity } = await import("@/lib/director-activity");
    await recordDirectorActivity(admin, {
      workspaceId: input.workspaceId,
      directorFunction: "cs",
      actionKind: "compiled_trees_extracted",
      specSlug: null,
      reason: (input.verdict.reasoning || "").slice(0, 4000),
      metadata: {
        job_id: input.jobId,
        trees_upserted: upserted,
        trees_proposed: input.verdict.trees.length,
        skipped_reasons: skipped.slice(0, 20),
        autonomous: true,
        phase: 1,
      },
    });
  } catch (e) {
    console.warn("[playbook-compiler] director_activity write failed:", e instanceof Error ? e.message : e);
  }

  return { treesUpserted: upserted, reasonSkipped: skipped };
}

/** One workspace's stats — enough for the cron to skip a workspace with no
 *  mineable history without spawning an agent session. */
export interface PlaybookCompileScope {
  workspaceId: string;
  ticketAnalysisCount: number;
  confirmedResolutionCount: number;
}

/**
 * List workspaces with any mineable ticket_analyses OR confirmed
 * ticket_resolution_events. The Inngest cron uses this to decide which
 * workspaces get a `playbook-compile` agent_job enqueued this pass.
 * Best-effort — an error returns an empty list so the cron no-ops rather
 * than fanning out on partial data.
 */
export async function listCompilableWorkspaces(admin: SupabaseClient): Promise<PlaybookCompileScope[]> {
  const out = new Map<string, PlaybookCompileScope>();
  const bump = (workspaceId: string, key: "ticketAnalysisCount" | "confirmedResolutionCount") => {
    const row = out.get(workspaceId);
    if (row) row[key] += 1;
    else out.set(workspaceId, {
      workspaceId,
      ticketAnalysisCount: key === "ticketAnalysisCount" ? 1 : 0,
      confirmedResolutionCount: key === "confirmedResolutionCount" ? 1 : 0,
    });
  };
  try {
    const { data } = await admin
      .from("ticket_analyses")
      .select("workspace_id")
      .limit(50000);
    for (const r of (data || []) as Array<{ workspace_id: string }>) bump(r.workspace_id, "ticketAnalysisCount");
  } catch { /* best-effort */ }
  try {
    const { data } = await admin
      .from("ticket_resolution_events")
      .select("workspace_id")
      .eq("verified_outcome", "confirmed")
      .limit(50000);
    for (const r of (data || []) as Array<{ workspace_id: string }>) bump(r.workspace_id, "confirmedResolutionCount");
  } catch { /* best-effort */ }
  return Array.from(out.values());
}

/** One resolution-event row the brief-builder loads per workspace. */
export interface FullHistoryResolutionRow {
  id: string;
  ticket_id: string;
  problem: string | null;
  options: unknown;
  chosen: unknown;
  verified_outcome: string | null;
  staged_at: string | null;
}

/** One ticket_analyses row the brief-builder loads per workspace. */
export interface FullHistoryAnalysisRow {
  id: string;
  ticket_id: string;
  score: number | null;
  summary: string | null;
  issues: unknown;
  action_items: unknown;
  created_at: string | null;
}

/** The full-history snapshot the box agent's runner passes into the session. */
export interface PlaybookCompileBrief {
  supportMin: number;
  resolutionRows: FullHistoryResolutionRow[];
  analysisRows: FullHistoryAnalysisRow[];
  precomputedClusters: Cluster[];
  headerText: string;
}

/**
 * Build the FULL-history brief the box agent reasons over — the read replaces
 * the old 30-day-only ticket_resolution_events fetch: we now ALSO pull
 * ticket_analyses (the analyzer's own signal) so the agent can cluster on
 * outcome-verified turns AND on high-priority pattern hints the analyzer has
 * already surfaced. No 30-day floor: the spec's Phase-1 verification is
 * "trees derived from the FULL history".
 *
 * The runner pre-computes the deterministic (problem × action_types) cluster
 * shape via `bucketClusters` and hands it to the agent as ground truth — the
 * agent's job is to name each tree (intent distribution, resolution sequence,
 * reasoning), not to re-derive the deterministic clustering.
 */
export async function loadPlaybookCompileBrief(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<PlaybookCompileBrief> {
  const supportMin = await loadSupportMin(admin, workspaceId);

  // Read the FULL history — no staged_at filter (the whole point of Phase 1 is
  // the 30-day-floor going away). We still scope to verified_outcome=confirmed
  // because unbacked/drifted/clarified rows are compiler signal AGAINST the
  // tree, not evidence FOR it (same rule the old cron used, kept here so the
  // clustering stays trust-worthy).
  const { data: resRows } = await admin
    .from("ticket_resolution_events")
    .select("id, ticket_id, problem, options, chosen, verified_outcome, staged_at")
    .eq("workspace_id", workspaceId)
    .eq("verified_outcome", "confirmed");
  const resolutionRows = (resRows || []) as FullHistoryResolutionRow[];

  // ticket_analyses is the analyzer's per-ticket signal — score + summary +
  // issues array + action_items array. The full sweep is intentional: even a
  // low-support cluster surfaces here as evidence for the agent's reasoning.
  const { data: anRows } = await admin
    .from("ticket_analyses")
    .select("id, ticket_id, score, summary, issues, action_items, created_at")
    .eq("workspace_id", workspaceId);
  const analysisRows = (anRows || []) as FullHistoryAnalysisRow[];

  const precomputedClusters = bucketClusters(
    resolutionRows.map((r) => ({
      id: r.id,
      ticket_id: r.ticket_id,
      problem: r.problem,
      options: r.options,
      chosen: r.chosen,
      verified_outcome: r.verified_outcome,
      staged_at: r.staged_at ?? "",
    })),
  );

  const eligibleCount = precomputedClusters.filter((c) => c.support >= supportMin).length;

  const parts: string[] = [];
  parts.push(`PLAYBOOK-COMPILER BRIEF — workspace ${workspaceId}`);
  parts.push(`support_min=${supportMin} · ticket_analyses=${analysisRows.length} · confirmed_resolution_events=${resolutionRows.length}`);
  parts.push(`precomputed clusters=${precomputedClusters.length} · at-or-above support_min=${eligibleCount}`);
  parts.push("");
  parts.push("PRECOMPUTED CLUSTERS (deterministic; you MUST reuse each tree_key verbatim):");
  const CLUSTER_CAP = 40;
  const clusterSlice = precomputedClusters.slice(0, CLUSTER_CAP);
  for (const c of clusterSlice) {
    parts.push(`  · tree_key=${c.key}`);
    parts.push(`    problem=${c.problem} · action_types=${c.actionTypes.join("+")} · support=${c.support}`);
    parts.push(`    samples=${c.sampleTicketIds.slice(0, 5).join(", ")}`);
  }
  if (precomputedClusters.length > clusterSlice.length) {
    parts.push(`  · … + ${precomputedClusters.length - clusterSlice.length} more (truncated for brief size — every mineable pattern is in the DB)`);
  }
  parts.push("");
  parts.push("ANALYSIS SIGNAL — issue-tag distribution across ticket_analyses (recurring tags first):");
  const issueCounts = new Map<string, number>();
  for (const a of analysisRows) {
    if (Array.isArray(a.issues)) {
      for (const it of a.issues) {
        const tag = typeof it === "string" ? it : typeof (it as { tag?: unknown })?.tag === "string" ? (it as { tag: string }).tag : null;
        if (!tag) continue;
        issueCounts.set(tag, (issueCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  const topIssues = [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [tag, n] of topIssues) parts.push(`  · ${tag}: ${n} analyses`);
  if (topIssues.length === 0) parts.push("  (no issue tags surfaced across ticket_analyses)");

  return {
    supportMin,
    resolutionRows,
    analysisRows,
    precomputedClusters,
    headerText: parts.join("\n"),
  };
}

/** Convenience — cron-side callers can drop the admin plumbing. */
export async function loadPlaybookCompileBriefFromWorkspaceId(workspaceId: string): Promise<PlaybookCompileBrief> {
  const admin = createAdminClient();
  return loadPlaybookCompileBrief(admin, workspaceId);
}
