/**
 * Media Buyer grader — score each concluded Media Buyer action against realized ROAS
 * (media-buyer-test-winner-loop Phase 3). Extends the box grading cascade (mirrors
 * [[storefront-campaign-grader]] / [[agent-grader]]) with a DETERMINISTIC grader (no
 * Max session — the scoring is straightforward math on ROAS vs policy thresholds).
 *
 * Two orthogonal quality axes per action, scored 1–10:
 *   • decision_quality — was the CALL SOUND given what the Media Buyer could see at
 *     decision time? A promote on a strong-ROAS winner scores high here even if the
 *     realized ROAS later regressed.
 *   • outcome_quality — did the REALIZED ROAS (resolved AT GRADING TIME, ≥ 3 days
 *     after the action) actually support the call? Independent of decision quality.
 *
 * A sound call that regressed on a later ROAS shift still scores well
 * (`decision_quality=high`, `outcome_quality=low`) — the spec's rubric discipline.
 *
 * Reads:
 *   • The action row from [[../../tables/director_activity]] (metadata carries the
 *     decision-time signals: source_meta_ad_id, roas at decision time, policy_version).
 *   • The active policy from [[../meta/decision-engine]] `loadActivePolicy` — the
 *     thresholds it was scored against (roas_floor / scale_up_roas_trigger).
 *   • Realized ROAS from [[../../tables/meta_attribution_daily]] for the source
 *     `meta_ad_id` over the window `[action.created_at + 3d, action.created_at + 10d]`
 *     — settled attribution.
 *
 * Writes:
 *   • One row to [[../../tables/media_buyer_action_grades]] per action, keyed on
 *     `director_activity_id` (idempotent — a re-grade UPDATES in place). NEVER mutates
 *     the source `director_activity` row.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { loadActivePolicy, type IterationPolicy } from "@/lib/meta/decision-engine";

type Admin = ReturnType<typeof createAdminClient>;

/** How many days after the action must pass before its outcome is judged settled. */
export const REALIZED_WINDOW_MIN_DAYS = 3;
/** Outer bound of the settled window (window is [+minDays, +maxDays] after action). */
export const REALIZED_WINDOW_MAX_DAYS = 10;

/** The subset of Media Buyer action_kinds the grader knows how to score. */
export const GRADEABLE_ACTION_KINDS = [
  "media_buyer_promoted_winner",
  "media_buyer_paused_loser",
  "media_buyer_replenished_test_cohort",
  "media_buyer_fatigue_replenish_triggered",
] as const;
export type GradeableActionKind = (typeof GRADEABLE_ACTION_KINDS)[number];

/** One row from `director_activity` the grader processes. */
export interface MediaBuyerActionRow {
  id: string;
  workspace_id: string;
  action_kind: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** Rolled-up realized attribution for one source `meta_ad_id` over the settled window. */
export interface RealizedAttribution {
  spendCents: number;
  revenueCents: number;
  roas: number | null;
  windowStart: string;
  windowEnd: string;
}

/** The typed grade the pure scorer emits — the row shape written to `media_buyer_action_grades`. */
export interface MediaBuyerGrade {
  actionKind: GradeableActionKind;
  sourceMetaAdId: string | null;
  decisionRoas: number | null;
  realized: RealizedAttribution | null;
  decisionQuality: number;
  outcomeQuality: number;
  overallGrade: number;
  reasoning: string;
}

/** Clamp a raw 1–10-ish score into the DB check constraint. */
function clampGrade(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(10, Math.round(n)));
}

/** ROAS at decision time — from the action row's metadata (nullable when absent). */
function decisionRoasOf(action: MediaBuyerActionRow): number | null {
  const r = (action.metadata as { roas?: unknown } | null)?.roas;
  if (typeof r === "number" && Number.isFinite(r)) return r;
  if (typeof r === "string" && r.length) {
    const n = Number(r);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Source meta_ad_id from the action row's metadata. */
function sourceMetaAdIdOf(action: MediaBuyerActionRow): string | null {
  const s = (action.metadata as { source_meta_ad_id?: unknown } | null)?.source_meta_ad_id;
  return typeof s === "string" && s.length ? s : null;
}

/**
 * Pure scorer — given the decision-time signals, policy, and realized attribution, emit the
 * typed grade. No DB, no side effects. Exposed as its own export so unit tests hit this without
 * touching Supabase.
 */
export function scoreMediaBuyerAction(
  action: MediaBuyerActionRow,
  policy: IterationPolicy,
  realized: RealizedAttribution | null,
): MediaBuyerGrade {
  const actionKind = action.action_kind as GradeableActionKind;
  const decisionRoas = decisionRoasOf(action);
  const sourceMetaAdId = sourceMetaAdIdOf(action);
  const trigger = policy.scale_up_roas_trigger;
  const floor = policy.roas_floor;

  // ── decision_quality: rate the CALL at the time it was made ────────────────
  let decisionQuality: number;
  let decisionReason: string;
  switch (actionKind) {
    case "media_buyer_promoted_winner":
    case "media_buyer_fatigue_replenish_triggered":
      // A promote / fatigue-replenish is sound when the winner's decision-time ROAS was clearly
      // above scale_up_roas_trigger. More margin over trigger = higher decision_quality.
      if (decisionRoas == null) {
        decisionQuality = 4;
        decisionReason = `decision-time ROAS missing from the action metadata — cannot judge the call directly`;
      } else if (decisionRoas >= trigger * 1.5) {
        decisionQuality = 10;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} ≥ trigger ${trigger.toFixed(2)} × 1.5 (clear-margin winner)`;
      } else if (decisionRoas >= trigger * 1.2) {
        decisionQuality = 9;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} ≥ trigger ${trigger.toFixed(2)} × 1.2 (comfortable margin)`;
      } else if (decisionRoas >= trigger) {
        decisionQuality = 7;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} at trigger ${trigger.toFixed(2)} (thin margin)`;
      } else {
        decisionQuality = 3;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} < trigger ${trigger.toFixed(2)} (promote should not have fired)`;
      }
      break;
    case "media_buyer_paused_loser":
      // A pause is sound when the loser's decision-time ROAS was clearly below roas_floor.
      // Deeper below = higher decision_quality.
      if (decisionRoas == null) {
        decisionQuality = 4;
        decisionReason = `decision-time ROAS missing from the action metadata — cannot judge the call directly`;
      } else if (decisionRoas <= floor * 0.5) {
        decisionQuality = 10;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} ≤ floor ${floor.toFixed(2)} × 0.5 (deep underperform, kill correct)`;
      } else if (decisionRoas <= floor * 0.75) {
        decisionQuality = 8;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} ≤ floor ${floor.toFixed(2)} × 0.75 (clear underperform)`;
      } else if (decisionRoas < floor) {
        decisionQuality = 6;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} < floor ${floor.toFixed(2)} (marginal underperform)`;
      } else {
        decisionQuality = 3;
        decisionReason = `decision-time ROAS ${decisionRoas.toFixed(2)} ≥ floor ${floor.toFixed(2)} (pause should not have fired)`;
      }
      break;
    case "media_buyer_replenished_test_cohort":
      // A replenish is a supply-side action — the "call" is always sound if the cohort was in
      // deficit (which the runner checks). Default to 8; a missing config downgrade grades lower.
      decisionQuality = 8;
      decisionReason = `Replenish action published a ready-to-test creative into the test cohort — supply-side, cohort was in deficit at decision time`;
      break;
    default:
      decisionQuality = 5;
      decisionReason = `unknown action_kind ${actionKind} — default middling score`;
  }

  // ── outcome_quality: judge the CALL against realized attribution ──────────
  let outcomeQuality: number;
  let outcomeReason: string;
  const realizedRoas = realized?.roas ?? null;
  switch (actionKind) {
    case "media_buyer_promoted_winner":
    case "media_buyer_fatigue_replenish_triggered":
    case "media_buyer_replenished_test_cohort":
      // Scaled/replenished creatives should keep clearing the floor after the action lands.
      if (realizedRoas == null) {
        outcomeQuality = 4;
        outcomeReason = `no realized attribution in the ${REALIZED_WINDOW_MIN_DAYS}–${REALIZED_WINDOW_MAX_DAYS}d settled window — the scaled/new creative didn't sustain spend, weak outcome`;
      } else if (realizedRoas >= trigger) {
        outcomeQuality = 10;
        outcomeReason = `realized ROAS ${realizedRoas.toFixed(2)} ≥ trigger ${trigger.toFixed(2)} — the scale-up / replenish held its edge`;
      } else if (realizedRoas >= floor) {
        outcomeQuality = 7;
        outcomeReason = `realized ROAS ${realizedRoas.toFixed(2)} ≥ floor ${floor.toFixed(2)} but < trigger — the ad regressed off its winner state but stayed above the pause line`;
      } else {
        outcomeQuality = 3;
        outcomeReason = `realized ROAS ${realizedRoas.toFixed(2)} < floor ${floor.toFixed(2)} — the promote/replenish underperformed against post-action attribution`;
      }
      break;
    case "media_buyer_paused_loser":
      // A pause is correct when the paused object's realized spend/revenue drops to ~zero.
      // Non-zero realized spend after the pause means either it was unpaused or a proxy leaked.
      if (realized == null || (realized.spendCents ?? 0) === 0) {
        outcomeQuality = 10;
        outcomeReason = `no realized spend in the settled window — pause held (correct call)`;
      } else if ((realized.spendCents ?? 0) > 0 && realizedRoas != null && realizedRoas >= floor) {
        // Some spend AND above-floor ROAS → the pause was reverted (correctly, via unpause) and it worked.
        outcomeQuality = 7;
        outcomeReason = `paused object saw realized spend + realized ROAS ${realizedRoas.toFixed(2)} ≥ floor — was unpaused and recovered`;
      } else {
        outcomeQuality = 5;
        outcomeReason = `paused object saw realized spend ${realized.spendCents} at ROAS ${realizedRoas?.toFixed(2) ?? "n/a"} — either unpaused too soon or attribution leaked past the pause`;
      }
      break;
    default:
      outcomeQuality = 5;
      outcomeReason = `unknown action_kind ${actionKind} — default outcome score`;
  }

  const overallGrade = clampGrade((decisionQuality + outcomeQuality) / 2);
  const reasoning = `decision: ${decisionReason}. outcome: ${outcomeReason}.`;

  return {
    actionKind,
    sourceMetaAdId,
    decisionRoas,
    realized,
    decisionQuality: clampGrade(decisionQuality),
    outcomeQuality: clampGrade(outcomeQuality),
    overallGrade,
    reasoning,
  };
}

/**
 * Resolve REALIZED attribution for one `meta_ad_id` over the settled window
 * `[action + minDays, action + maxDays]`. Returns null when there's no attribution
 * in the window — that IS the correct signal for a paused loser's outcome.
 */
export async function loadRealizedAttribution(
  admin: Admin,
  args: {
    workspaceId: string;
    metaAdId: string;
    actionCreatedAt: string;
    minDays?: number;
    maxDays?: number;
  },
): Promise<RealizedAttribution | null> {
  const minDays = args.minDays ?? REALIZED_WINDOW_MIN_DAYS;
  const maxDays = args.maxDays ?? REALIZED_WINDOW_MAX_DAYS;
  const base = new Date(args.actionCreatedAt).getTime();
  if (!Number.isFinite(base)) return null;
  const startMs = base + minDays * 86400_000;
  const endMs = base + maxDays * 86400_000;
  const windowStart = new Date(startMs).toISOString().slice(0, 10);
  const windowEnd = new Date(endMs).toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("meta_attribution_daily")
    .select("attributed_spend_cents, revenue_cents")
    .eq("workspace_id", args.workspaceId)
    .eq("meta_ad_id", args.metaAdId)
    .gte("snapshot_date", windowStart)
    .lte("snapshot_date", windowEnd);
  if (error) return null;
  const rows = (data || []) as Array<{ attributed_spend_cents: number | string | null; revenue_cents: number | string | null }>;
  if (!rows.length) return { spendCents: 0, revenueCents: 0, roas: null, windowStart, windowEnd };
  let spendCents = 0;
  let revenueCents = 0;
  for (const r of rows) {
    spendCents += Number(r.attributed_spend_cents ?? 0);
    revenueCents += Number(r.revenue_cents ?? 0);
  }
  const roas = spendCents > 0 ? Number((revenueCents / spendCents).toFixed(4)) : null;
  return { spendCents, revenueCents, roas, windowStart, windowEnd };
}

export interface GradeMediaBuyerActionResult {
  graded: number;
  skipped: number;
  errors: number;
  grades: Array<{ directorActivityId: string; grade: MediaBuyerGrade }>;
}

/**
 * The runner's chokepoint. Reads every UNGRADED media-buyer `director_activity` row
 * older than the settled window, resolves realized ROAS, scores, and UPSERTS one
 * grade row per action_id. Idempotent — the UNIQUE index on `director_activity_id`
 * collapses re-runs; the `.select("id")` on the write asserts exactly one row
 * transitioned per action (compare-and-set guard against a concurrent grader).
 *
 * No active policy → no grades emitted (the grader depends on the policy thresholds
 * that produced the actions in the first place — grading against a null policy is a
 * category error).
 */
export async function gradeMediaBuyerActions(
  admin: Admin,
  opts: { workspaceId: string; nowMs?: number; limit?: number },
): Promise<GradeMediaBuyerActionResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffIso = new Date(nowMs - REALIZED_WINDOW_MIN_DAYS * 86400_000).toISOString();
  const limit = opts.limit ?? 50;

  const policy = await loadActivePolicy(opts.workspaceId, "");
  if (!policy) return { graded: 0, skipped: 0, errors: 0, grades: [] };

  // Read the gradeable action rows in the settled window.
  const { data: actionsRaw, error: actionsErr } = await admin
    .from("director_activity")
    .select("id, workspace_id, action_kind, created_at, metadata")
    .eq("workspace_id", opts.workspaceId)
    .in("action_kind", GRADEABLE_ACTION_KINDS as readonly string[])
    .lte("created_at", cutoffIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (actionsErr) return { graded: 0, skipped: 0, errors: 1, grades: [] };
  const actions = (actionsRaw || []) as MediaBuyerActionRow[];
  if (!actions.length) return { graded: 0, skipped: 0, errors: 0, grades: [] };

  // Skip already-graded rows.
  const actionIds = actions.map((a) => a.id);
  const { data: existingRaw } = await admin
    .from("media_buyer_action_grades")
    .select("director_activity_id")
    .in("director_activity_id", actionIds);
  const alreadyGraded = new Set(((existingRaw || []) as Array<{ director_activity_id: string }>).map((r) => r.director_activity_id));

  const result: GradeMediaBuyerActionResult = { graded: 0, skipped: 0, errors: 0, grades: [] };
  for (const action of actions) {
    if (alreadyGraded.has(action.id)) {
      result.skipped += 1;
      continue;
    }
    const sourceMetaAdId = sourceMetaAdIdOf(action);
    let realized: RealizedAttribution | null = null;
    if (sourceMetaAdId) {
      realized = await loadRealizedAttribution(admin, {
        workspaceId: opts.workspaceId,
        metaAdId: sourceMetaAdId,
        actionCreatedAt: action.created_at,
      });
    }
    const grade = scoreMediaBuyerAction(action, policy, realized);

    const row = {
      workspace_id: opts.workspaceId,
      director_activity_id: action.id,
      action_kind: action.action_kind,
      source_meta_ad_id: grade.sourceMetaAdId,
      decision_roas: grade.decisionRoas,
      realized_roas: grade.realized?.roas ?? null,
      realized_window_start: grade.realized?.windowStart ?? null,
      realized_window_end: grade.realized?.windowEnd ?? null,
      realized_spend_cents: grade.realized?.spendCents ?? null,
      realized_revenue_cents: grade.realized?.revenueCents ?? null,
      decision_quality: grade.decisionQuality,
      outcome_quality: grade.outcomeQuality,
      overall_grade: grade.overallGrade,
      reasoning: grade.reasoning,
      graded_by: "agent" as const,
      graded_at: new Date(nowMs).toISOString(),
    };
    // UPSERT keyed on the UNIQUE `director_activity_id`. `.select("id")` asserts exactly one
    // row transitioned so a concurrent grader (or a re-run) can't silently no-op.
    const { data: written, error: writeErr } = await admin
      .from("media_buyer_action_grades")
      .upsert(row, { onConflict: "director_activity_id" })
      .select("id");
    if (writeErr) {
      result.errors += 1;
      continue;
    }
    if (!written || written.length !== 1) {
      // Zero rows transitioned = someone else already graded it. Non-fatal.
      result.skipped += 1;
      continue;
    }
    result.graded += 1;
    result.grades.push({ directorActivityId: action.id, grade });
  }
  return result;
}
