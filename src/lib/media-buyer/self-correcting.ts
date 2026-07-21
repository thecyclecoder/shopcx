/**
 * media-buyer/self-correcting — the automatic revert that closes the
 * [[../../../docs/brain/goals/autonomous-media-buyer-supervision]] M4 loop.
 *
 * When the Growth Director's supervised Media Buyer stays armed but its
 * [[../../../docs/brain/tables/media_buyer_action_grades]] rolling average slides
 * below the sound-call threshold for a sustained run of days, don't wait for a
 * human to notice — flip the cohort back to `shadow` and route a CEO card. This
 * is the M4 "graded + self-correcting" milestone: the ⭐ north-star principle
 * ([[../../../docs/brain/operational-rules.md]] § North star) says a
 * proxy-optimizing tool always answers to an objective owner, so a sustained
 * grade regression MUST auto-disarm rather than silently keep spending.
 *
 * Detection (per (workspace, meta_ad_account_id) cohort):
 *   • Bucket the last 14 days of `media_buyer_action_grades.overall_grade` by
 *     `date_trunc('day', graded_at)` and roll them up per day into
 *     { day, avg_overall_grade, count }.
 *   • Walk that array right-to-left and count the TRAILING streak of days where
 *     `avg_overall_grade < 5` AND `count >= 2` (the ≥2 guard prevents a single
 *     out-of-luck action from dragging the streak).
 *   • A streak length ≥ 7 → sustained regression.
 *
 * Action (only fires when detection triggers AND current mode='armed'):
 *   1. Flip `iteration_policies` to `mode='shadow'` via
 *      [[./mode-flip]] `flipMediaBuyerPolicyMode` — the same compare-and-set the
 *      owner disarm route uses.
 *   2. Record one [[../../../docs/brain/tables/director_activity]] row
 *      `action_kind='media_buyer_self_disarmed'` under
 *      `director_function='growth'` with metadata
 *      `{ streak_days, avg_overall_grade, threshold: 5, meta_ad_account_id, updated_policy_ids }`.
 *   3. Escalate to the CEO via
 *      [[../agents/platform-director]] `escalateDiagnosisToCeo` with
 *      `escalationKind='media_buyer_regressed_disarmed'` and
 *      `dedupeKey='media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}'` so a
 *      second pass on the same cohort does NOT double-surface the notification.
 *
 * Idempotency + safety:
 *   • Already in `shadow` (or already `superseded`) → NO mutation, NO director_activity,
 *     NO escalation. The re-run yields `{ disarmed: false, reason: 'not_armed' }`.
 *   • Detection under threshold → NO mutation, NO escalation, {disarmed:false, reason:'no_regression'}.
 *   • The dashboard_notifications dedupe (see `escalateDiagnosisToCeo`) drops a second CEO
 *     card for the same cohort — the retry is safe.
 *
 * Never throws: an unexpected Supabase error resolves as
 * `{ disarmed: false, reason: 'error', error }` so the caller (the inngest fanout) can
 * log-and-continue over the next cohort instead of aborting the whole pass.
 */
import type { PostgrestError } from "@supabase/supabase-js";
import { errText } from "@/lib/error-text";
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { flipMediaBuyerPolicyMode } from "@/lib/media-buyer/mode-flip";

type Admin = ReturnType<typeof createAdminClient>;

const GROWTH_FUNCTION = "growth";
const SPEC_SLUG = "media-buyer-self-correcting-mode-revert";

/** The daily-average grade a cohort must slip UNDER to count as a `below` day. */
export const REGRESSION_GRADE_THRESHOLD = 5;

/** Minimum graded actions per day for that day to qualify as a `below` day (noise guard). */
export const REGRESSION_MIN_DAILY_COUNT = 2;

/** Trailing streak length (days) required to trip the auto-disarm. */
export const REGRESSION_STREAK_DAYS = 7;

/** Sliding window (days) the detector reads. Must be ≥ REGRESSION_STREAK_DAYS. */
export const REGRESSION_LOOKBACK_DAYS = 14;

/** The rolling per-day bucket the pure streak scorer consumes. */
export interface DailyGradeBucket {
  /** ISO day (`YYYY-MM-DD`) — chronological order. */
  day: string;
  /** Arithmetic mean of `overall_grade` values graded on this day (1..10). */
  avg_overall_grade: number;
  /** Count of graded rows on this day. */
  count: number;
}

export interface RegressionSignals {
  /** The trailing streak of consecutive days ending on the last bucket that all satisfied `avg < threshold AND count >= minCount`. */
  streakDays: number;
  /** The arithmetic mean of the trailing streak's per-day `avg_overall_grade` values (NaN when streakDays=0). */
  streakAvgOverallGrade: number;
  /** Whether the streak clears `REGRESSION_STREAK_DAYS`. */
  regressed: boolean;
}

/**
 * Pure detector — right-to-left trailing streak of days where the per-day average sits UNDER
 * `threshold` AND the day carries ≥ `minCount` graded rows. Called by
 * `checkMediaBuyerRegressionAndDisarm` after it rolls the DB read into buckets, and exposed for
 * unit tests to pin the streak math without touching Supabase.
 *
 * Buckets MUST be chronological (oldest → newest). Any bucket missing either predicate breaks
 * the streak immediately — a run of low days interrupted by a single healthy day resets to 0.
 */
export function detectMediaBuyerRegression(
  buckets: DailyGradeBucket[],
  opts: {
    threshold?: number;
    minCount?: number;
    streakDays?: number;
  } = {},
): RegressionSignals {
  const threshold = opts.threshold ?? REGRESSION_GRADE_THRESHOLD;
  const minCount = opts.minCount ?? REGRESSION_MIN_DAILY_COUNT;
  const requiredStreak = opts.streakDays ?? REGRESSION_STREAK_DAYS;

  let streak = 0;
  let streakSum = 0;
  for (let i = buckets.length - 1; i >= 0; i -= 1) {
    const b = buckets[i];
    if (b.count < minCount) break;
    if (!(b.avg_overall_grade < threshold)) break;
    streak += 1;
    streakSum += b.avg_overall_grade;
  }
  const streakAvgOverallGrade = streak > 0 ? streakSum / streak : Number.NaN;
  return {
    streakDays: streak,
    streakAvgOverallGrade,
    regressed: streak >= requiredStreak,
  };
}

interface GradeRowLite {
  overall_grade: number;
  graded_at: string;
  meta_ad_account_id: string | null;
}

/**
 * Bucket a flat set of grade rows into per-day averages (UTC day). Public so tests can construct
 * bucket fixtures without a Supabase round-trip.
 */
export function bucketGradesByDay(rows: GradeRowLite[]): DailyGradeBucket[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.overall_grade)) continue;
    const day = r.graded_at.slice(0, 10);
    const bag = byDay.get(day) ?? { sum: 0, count: 0 };
    bag.sum += r.overall_grade;
    bag.count += 1;
    byDay.set(day, bag);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, bag]) => ({ day, avg_overall_grade: bag.sum / bag.count, count: bag.count }));
}

export interface CheckMediaBuyerRegressionArgs {
  admin: Admin;
  workspaceId: string;
  /** null → the workspace-wide cohort (grade rows whose director_activity.metadata carries NO meta_ad_account_id). */
  metaAdAccountId: string | null;
  /** ISO reference "now" (defaults to real now) — makes tests deterministic. */
  nowIso?: string;
}

export type CheckMediaBuyerRegressionOutcome =
  | { disarmed: true; streakDays: number; avgOverallGrade: number; updatedPolicyIds: string[]; escalated: boolean }
  | { disarmed: false; reason: "not_armed" | "no_regression" | "no_grades" | "no_policy"; streakDays: number; avgOverallGrade: number | null }
  | { disarmed: false; reason: "error"; error: string };

/** Load the active v1 policy's mode. NULL when no active workspace-scope row exists. */
async function loadActivePolicyMode(admin: Admin, workspaceId: string): Promise<{ mode: string | null; error?: PostgrestError }> {
  const { data, error } = await admin
    .from("iteration_policies")
    .select("mode")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .is("campaign_id", null)
    .limit(1)
    .maybeSingle();
  if (error) return { mode: null, error };
  return { mode: (data as { mode?: string } | null)?.mode ?? null };
}

/**
 * Load the last-14-day grade rows for one (workspace, meta_ad_account_id) cohort. The grade
 * table has `workspace_id` but the meta_ad_account_id lives on the JOINED
 * `director_activity.metadata` (see the arming-gate helper for the same pattern) — so we read
 * with a `!inner` on director_activity, then filter in code.
 */
async function loadCohortGrades(
  admin: Admin,
  args: { workspaceId: string; metaAdAccountId: string | null; sinceIso: string },
): Promise<{ rows: GradeRowLite[]; error?: PostgrestError }> {
  const { data, error } = await admin
    .from("media_buyer_action_grades")
    .select(
      "overall_grade, graded_at, director_activity:director_activity!inner(metadata)",
    )
    .eq("workspace_id", args.workspaceId)
    .gte("graded_at", args.sinceIso);
  if (error) return { rows: [], error };
  const raw = (data ?? []) as Array<{
    overall_grade: number | null;
    graded_at: string | null;
    director_activity?: { metadata?: Record<string, unknown> | null } | null;
  }>;
  const rows: GradeRowLite[] = [];
  for (const r of raw) {
    if (r.graded_at == null) continue;
    if (r.overall_grade == null || !Number.isFinite(r.overall_grade)) continue;
    const metaAccount = r.director_activity?.metadata?.["meta_ad_account_id"];
    const metaAccountStr = typeof metaAccount === "string" && metaAccount ? metaAccount : null;
    if (args.metaAdAccountId === null) {
      if (metaAccountStr !== null) continue; // workspace-wide bucket → only rows with NO meta account.
    } else if (metaAccountStr !== args.metaAdAccountId) {
      continue;
    }
    rows.push({ overall_grade: r.overall_grade, graded_at: r.graded_at, meta_ad_account_id: metaAccountStr });
  }
  return { rows };
}

function dedupeKeyFor(workspaceId: string, metaAdAccountId: string | null): string {
  return `media_buyer_regressed_disarmed:${workspaceId}:${metaAdAccountId ?? "_workspace_"}`;
}

/**
 * The main entry point — one cohort's regression check + auto-disarm. Idempotent (a
 * second call on an already-shadow cohort no-ops); never throws (errors resolve as
 * `{ disarmed: false, reason: 'error', error }`). See file header for the full contract.
 */
export async function checkMediaBuyerRegressionAndDisarm(
  args: CheckMediaBuyerRegressionArgs,
): Promise<CheckMediaBuyerRegressionOutcome> {
  const { admin, workspaceId, metaAdAccountId } = args;
  const nowMs = args.nowIso ? Date.parse(args.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - REGRESSION_LOOKBACK_DAYS * 86_400_000).toISOString();

  try {
    const policy = await loadActivePolicyMode(admin, workspaceId);
    if (policy.error) return { disarmed: false, reason: "error", error: policy.error.message };
    if (policy.mode === null) {
      return { disarmed: false, reason: "no_policy", streakDays: 0, avgOverallGrade: null };
    }
    if (policy.mode !== "armed") {
      return { disarmed: false, reason: "not_armed", streakDays: 0, avgOverallGrade: null };
    }

    const grades = await loadCohortGrades(admin, { workspaceId, metaAdAccountId, sinceIso });
    if (grades.error) return { disarmed: false, reason: "error", error: grades.error.message };
    if (grades.rows.length === 0) {
      return { disarmed: false, reason: "no_grades", streakDays: 0, avgOverallGrade: null };
    }

    const buckets = bucketGradesByDay(grades.rows);
    const signals = detectMediaBuyerRegression(buckets);
    if (!signals.regressed) {
      const avg =
        signals.streakDays > 0 && Number.isFinite(signals.streakAvgOverallGrade)
          ? signals.streakAvgOverallGrade
          : null;
      return { disarmed: false, reason: "no_regression", streakDays: signals.streakDays, avgOverallGrade: avg };
    }

    const flip = await flipMediaBuyerPolicyMode(admin, workspaceId, "shadow");
    if (!flip.ok) return { disarmed: false, reason: "error", error: flip.error ?? "flip failed" };

    const cohortLabel = metaAdAccountId ? `meta_ad_account ${metaAdAccountId}` : "workspace-wide cohort";
    const avgFmt = signals.streakAvgOverallGrade.toFixed(2);
    const diagnosis =
      `Media Buyer auto-disarmed (${cohortLabel}) after a ${signals.streakDays}-day streak of avg overall_grade ${avgFmt} < ${REGRESSION_GRADE_THRESHOLD}. ` +
      `iteration_policies flipped 'armed' → 'shadow' (${flip.updatedIds.length} row(s)).`;

    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: GROWTH_FUNCTION,
      actionKind: "media_buyer_self_disarmed",
      specSlug: SPEC_SLUG,
      reason: `regression_auto_disarm (streak=${signals.streakDays}d, avg=${avgFmt})`,
      metadata: {
        reason: "regression_auto_disarm",
        streak_days: signals.streakDays,
        avg_overall_grade: signals.streakAvgOverallGrade,
        threshold: REGRESSION_GRADE_THRESHOLD,
        meta_ad_account_id: metaAdAccountId,
        updated_policy_ids: flip.updatedIds,
        autonomous: true,
      },
    });

    const escalation = await escalateDiagnosisToCeo(admin, {
      workspaceId,
      specSlug: SPEC_SLUG,
      title: "Media Buyer auto-disarmed — grade regression",
      diagnosis,
      dedupeKey: dedupeKeyFor(workspaceId, metaAdAccountId),
      deepLink: "/dashboard/growth/media-buyer",
      escalationKind: "media_buyer_regressed_disarmed",
      metadata: {
        streak_days: signals.streakDays,
        avg_overall_grade: signals.streakAvgOverallGrade,
        threshold: REGRESSION_GRADE_THRESHOLD,
        meta_ad_account_id: metaAdAccountId,
      },
    });

    return {
      disarmed: true,
      streakDays: signals.streakDays,
      avgOverallGrade: signals.streakAvgOverallGrade,
      updatedPolicyIds: flip.updatedIds,
      escalated: escalation.emitted,
    };
  } catch (err) {
    return { disarmed: false, reason: "error", error: errText(err) };
  }
}

/**
 * Distinct armed workspaces the cron sweeps. Fanout input for the per-workspace event handler.
 * A workspace with NO active v1 armed policy contributes nothing.
 */
export async function findArmedWorkspaces(admin: Admin): Promise<string[]> {
  const { data, error } = await admin
    .from("iteration_policies")
    .select("workspace_id")
    .eq("status", "active")
    .eq("mode", "armed")
    .is("campaign_id", null);
  if (error) throw new Error(`iteration_policies armed read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ workspace_id: string }>;
  const set = new Set<string>();
  for (const r of rows) if (r.workspace_id) set.add(r.workspace_id);
  return [...set];
}

/**
 * The (meta_ad_account_id ∪ null) cohorts the per-workspace pass iterates. Derived from the
 * DISTINCT meta_ad_account_id values on the joined director_activity rows over the lookback
 * window: whichever accounts contributed grades. Always includes `null` — the workspace-wide
 * cohort covering rows with no meta account tag — so an armed workspace whose Media Buyer never
 * pinned an account can still auto-disarm on a regression.
 */
export async function findCohortMetaAdAccountIds(
  admin: Admin,
  args: { workspaceId: string; nowIso?: string },
): Promise<Array<string | null>> {
  const nowMs = args.nowIso ? Date.parse(args.nowIso) : Date.now();
  const sinceIso = new Date(nowMs - REGRESSION_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("media_buyer_action_grades")
    .select("director_activity:director_activity!inner(metadata)")
    .eq("workspace_id", args.workspaceId)
    .gte("graded_at", sinceIso);
  if (error) throw new Error(`media_buyer_action_grades cohorts read failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ director_activity?: { metadata?: Record<string, unknown> | null } | null }>;
  const accounts = new Set<string>();
  let sawWorkspaceWide = false;
  for (const r of rows) {
    const metaAccount = r.director_activity?.metadata?.["meta_ad_account_id"];
    if (typeof metaAccount === "string" && metaAccount) accounts.add(metaAccount);
    else sawWorkspaceWide = true;
  }
  const out: Array<string | null> = [...accounts];
  // Always include the workspace-wide cohort — an armed workspace with zero per-account rows
  // still needs to auto-disarm on a workspace-wide grade regression.
  if (sawWorkspaceWide || accounts.size === 0) out.push(null);
  return out;
}
