/**
 * Iteration-engine daily run orchestration — Storefront Iteration Engine Phase 5.
 *
 * Wires the pipeline into ONE reliable, self-correcting daily run per Meta ad
 * account and records it for supervisability:
 *
 *   ingest (P1) → attribution refresh (P2/2b) → rollups (P3)
 *     → reconcile prior actions (measure outcomes + link reversals)
 *     → autonomous policy actions (4a) → recommendation generation (4b)
 *     → execute autonomous adapters (6a — Phase 6, hook only here)
 *
 * Every stage is idempotent (each writes its own table on a stable key), so a
 * re-run never double-writes, double-recommends, or double-acts. Per-object
 * cooldown + the per-account daily budget-delta ceiling are enforced inside the
 * decision engine ([[decision-engine]] `computeAutonomousActions`); guardrail
 * hits land as `escalated` rows, never executed. Objects below the Phase 5 noise
 * floors (min spend / min sessions) are skipped for both actions + recommendations.
 * With NO active policy the run does scorecards + 4b recommendations only and
 * takes ZERO autonomous actions (the core safety invariant).
 *
 * This module owns: the `iteration_runs` run-record (startRun/finishRun), the
 * reconcile stage (outcome backfill + reversal linking on `iteration_actions`),
 * and the run-wide threshold constants. The Inngest wrapper is
 * `meta-iteration-run` in src/lib/inngest/meta-performance.ts.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 5).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ComputedAction, DecisionEngineParams } from "@/lib/meta/decision-engine";

// ── Run-wide noise floors (Phase 5; tunable, candidate for future policy fields) ─
// Below these a trailing window carries too little signal to act on — skip both
// autonomous actions and recommendations for the object.
export const MIN_ACTION_SPEND_CENTS = 500; // $5 trailing-window spend for ad/adset/campaign
export const MIN_VARIANT_SESSIONS = 30; // trailing-window sessions for a variant
// How long after a decision before its outcome is measurable in the trailing window.
export const OUTCOME_MATURATION_DAYS = 3;
// How far back the reconcile stage looks for still-open (un-reversed) actions to link.
const REVERSAL_LOOKBACK_DAYS = 30;

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

export interface StageRecord {
  name: string;
  status: "ok" | "skipped" | "error";
  ms: number;
  [k: string]: unknown;
}

// ── Run records (iteration_runs) ─────────────────────────────────────────────

/** Open a run record (status='running') and return its id. */
export async function startRun(
  p: DecisionEngineParams,
  trigger: "cron" | "manual",
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("iteration_runs")
    .insert({
      workspace_id: p.workspaceId,
      meta_ad_account_id: p.adAccountId,
      trigger,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`startRun failed: ${error?.message ?? "no row"}`);
  return data.id as string;
}

/** Close a run record with terminal status, stamping duration + summary. */
export async function finishRun(
  runId: string,
  fields: {
    status: "complete" | "failed";
    snapshotDate?: string | null;
    policy_active?: boolean;
    policy_version_id?: string | null;
    stages?: StageRecord[];
    counts?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<void> {
  const admin = createAdminClient();
  const now = new Date();
  // Recover started_at so we can stamp a duration even though the run row already exists.
  const { data: existing } = await admin
    .from("iteration_runs")
    .select("started_at")
    .eq("id", runId)
    .maybeSingle();
  const startedMs = existing?.started_at ? new Date(existing.started_at as string).getTime() : now.getTime();
  await admin
    .from("iteration_runs")
    .update({
      status: fields.status,
      snapshot_date: fields.snapshotDate ?? null,
      policy_active: fields.policy_active ?? false,
      policy_version_id: fields.policy_version_id ?? null,
      stages: fields.stages ?? [],
      counts: fields.counts ?? {},
      error: fields.error ?? null,
      finished_at: now.toISOString(),
      duration_ms: Math.max(0, now.getTime() - startedMs),
    })
    .eq("id", runId);
}

// ── Reconcile stage — measure prior-action outcomes + link reversals ─────────

/** object_id → the most recent still-open (un-reversed) scale_up / pause action id. */
export type OpenReversibles = Record<string, { scale_up?: string; pause?: string }>;

export interface ReconcileResult {
  outcomes_reconciled: number;
  openReversibles: OpenReversibles;
}

/**
 * Before the decision engine computes new actions: (1) backfill `outcome_*` on
 * prior `iteration_actions` whose maturation window has elapsed, measuring what
 * the object's trailing-window ROAS/revenue did after the decision day; and (2)
 * collect the still-open scale_up / pause actions per object so a new scale_down
 * or unpause this run can be linked to the action it reverses. Idempotent — only
 * touches rows whose outcome is not yet evaluated; safe to re-run.
 */
export async function reconcilePriorActions(
  p: DecisionEngineParams,
  snapshotDate: string,
): Promise<ReconcileResult> {
  const admin = createAdminClient();

  // Current trailing-window metrics per adset/campaign object (the outcome-after).
  const { data: scRows } = await admin
    .from("iteration_scorecards_daily")
    .select("object_id, roas, revenue_cents, window_days")
    .eq("meta_ad_account_id", p.adAccountId)
    .eq("snapshot_date", snapshotDate)
    .in("level", ["adset", "campaign"]);
  const metricByObject = new Map<string, { roas: number; revenue_cents: number; window_days: number }>();
  for (const r of (scRows || []) as { object_id: string; roas: number; revenue_cents: number; window_days: number }[]) {
    metricByObject.set(r.object_id, {
      roas: Number(r.roas ?? 0),
      revenue_cents: Number(r.revenue_cents ?? 0),
      window_days: Number(r.window_days ?? 0),
    });
  }

  // Actions decided far enough back that their outcome is now observable.
  const maturityCutoff = dayStr(new Date(Date.parse(snapshotDate) - OUTCOME_MATURATION_DAYS * 86400_000));
  const { data: matured } = await admin
    .from("iteration_actions")
    .select("id, object_id")
    .eq("workspace_id", p.workspaceId)
    .eq("meta_ad_account_id", p.adAccountId)
    .in("status", ["decided", "executed"])
    .is("outcome_evaluated_at", null)
    .lte("snapshot_date", maturityCutoff);

  let outcomes_reconciled = 0;
  const now = new Date().toISOString();
  for (const a of (matured || []) as { id: string; object_id: string }[]) {
    const m = metricByObject.get(a.object_id);
    if (!m) continue; // no current scorecard for this object → can't measure yet
    const { error } = await admin
      .from("iteration_actions")
      .update({
        outcome_roas: m.roas,
        outcome_revenue_cents: m.revenue_cents,
        outcome_window_days: m.window_days,
        outcome_evaluated_at: now,
        updated_at: now,
      })
      .eq("id", a.id);
    if (!error) outcomes_reconciled += 1;
  }

  // Still-open scale_up / pause actions, most recent per object — the reversal targets.
  const lookbackIso = new Date(Date.now() - REVERSAL_LOOKBACK_DAYS * 86400_000).toISOString();
  const { data: openRows } = await admin
    .from("iteration_actions")
    .select("id, object_id, action_type, created_at")
    .eq("workspace_id", p.workspaceId)
    .eq("meta_ad_account_id", p.adAccountId)
    .in("action_type", ["scale_up", "pause"])
    .in("status", ["decided", "executed"])
    .is("reversed_by_action_id", null)
    .gte("created_at", lookbackIso)
    .order("created_at", { ascending: false });
  const openReversibles: OpenReversibles = {};
  for (const r of (openRows || []) as { id: string; object_id: string; action_type: string }[]) {
    const entry = (openReversibles[r.object_id] ??= {});
    if (r.action_type === "scale_up" && !entry.scale_up) entry.scale_up = r.id;
    if (r.action_type === "pause" && !entry.pause) entry.pause = r.id;
  }

  return { outcomes_reconciled, openReversibles };
}

export interface ReversalLink {
  object_id: string;
  reversing_action_type: "scale_down" | "unpause";
  reversed_action_id: string;
}

/**
 * Pure: from this run's computed actions + the open-reversibles map, derive which
 * actions reverse a prior one. A scale_down reverts the object's open scale_up;
 * an unpause reverts its open pause.
 */
export function buildReversalLinks(actions: ComputedAction[], open: OpenReversibles): ReversalLink[] {
  const links: ReversalLink[] = [];
  for (const a of actions) {
    const entry = open[a.object_id];
    if (!entry) continue;
    if (a.action_type === "scale_down" && entry.scale_up) {
      links.push({ object_id: a.object_id, reversing_action_type: "scale_down", reversed_action_id: entry.scale_up });
    } else if (a.action_type === "unpause" && entry.pause) {
      links.push({ object_id: a.object_id, reversing_action_type: "unpause", reversed_action_id: entry.pause });
    }
  }
  return links;
}

/**
 * Persist the reversal links onto `iteration_actions` after this run's actions
 * have been written by `persistActions`: stamp the reversing row's
 * `reverses_action_id`, and flip the reverted row to `status='reversed'` with
 * `reversed_by_action_id`. Idempotent — re-running sets the same values.
 */
export async function linkReversals(
  p: DecisionEngineParams,
  snapshotDate: string,
  links: ReversalLink[],
): Promise<number> {
  if (!links.length) return 0;
  const admin = createAdminClient();
  const now = new Date().toISOString();
  let linked = 0;
  for (const l of links) {
    // The reversing action persistActions just wrote for this object/snapshot.
    const { data: rev } = await admin
      .from("iteration_actions")
      .select("id")
      .eq("workspace_id", p.workspaceId)
      .eq("meta_ad_account_id", p.adAccountId)
      .eq("object_id", l.object_id)
      .eq("action_type", l.reversing_action_type)
      .eq("snapshot_date", snapshotDate)
      .maybeSingle();
    if (!rev?.id) continue;
    await admin
      .from("iteration_actions")
      .update({ reverses_action_id: l.reversed_action_id, updated_at: now })
      .eq("id", rev.id);
    await admin
      .from("iteration_actions")
      .update({ reversed_by_action_id: rev.id as string, status: "reversed", updated_at: now })
      .eq("id", l.reversed_action_id);
    linked += 1;
  }
  return linked;
}
