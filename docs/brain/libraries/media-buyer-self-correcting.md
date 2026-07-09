# media-buyer/self-correcting

The auto-revert that closes the [[../goals/autonomous-media-buyer-supervision]] M4 "Graded + self-correcting" loop ([[../specs/media-buyer-self-correcting-mode-revert]] Phase 1). When an armed Media Buyer cohort's [[../tables/media_buyer_action_grades]] rolling per-day average slips below the sound-call threshold for a sustained streak, this flips the workspace's active v1 [[../tables/iteration_policies]] row from `mode='armed'` back to `mode='shadow'` and routes a CEO card via [[../libraries/platform-director]] `escalateDiagnosisToCeo` — no human needs to catch the slow decline.

**File:** `src/lib/media-buyer/self-correcting.ts` · runner in [[../inngest/media-buyer-self-correcting]] · shared mode-flip mutation in [[./media-buyer__mode-flip]]

## North-star fit

This is the ⭐ north-star discipline in action ([[../operational-rules]] § North star): the autonomous Media Buyer is a proxy-optimizing tool; the Growth Director is its objective owner; the CEO owns the company objective. A sustained grade regression IS the signal that the proxy has drifted from the objective — the tool must revert (not push through) and the objective-owner (CEO) must be told. This module is the revert + the escalation, in one atomic pass.

## Contract

```ts
export interface CheckMediaBuyerRegressionArgs {
  admin: Admin;
  workspaceId: string;
  /** null → workspace-wide cohort (grade rows with NO meta_ad_account_id metadata). */
  metaAdAccountId: string | null;
  nowIso?: string;
}

export type CheckMediaBuyerRegressionOutcome =
  | { disarmed: true; streakDays; avgOverallGrade; updatedPolicyIds; escalated }
  | { disarmed: false; reason: "not_armed" | "no_regression" | "no_grades" | "no_policy"; streakDays; avgOverallGrade }
  | { disarmed: false; reason: "error"; error };

export function checkMediaBuyerRegressionAndDisarm(args): Promise<CheckMediaBuyerRegressionOutcome>
```

Idempotent: a second call after the disarm sees `mode='shadow'` and returns `{ disarmed: false, reason: "not_armed" }` — NO mutation, NO director_activity row, NO escalation. Never throws — Supabase / platform-director errors resolve as `{ disarmed:false, reason:"error", error }` so the fan-out sweeps every cohort even when one errors.

## Detection

Detection is a pure right-to-left trailing streak over per-day buckets, exposed as `detectMediaBuyerRegression` for unit tests.

- **Read** the last 14 days of `media_buyer_action_grades` for `(workspace_id, meta_ad_account_id)` — the account filter reads the JOINED [[../tables/director_activity]] `metadata.meta_ad_account_id` (same pattern as [[./media-buyer__arming-gate]] uses to scope shadow reviews).
- **Bucket** by UTC day: `{ day, avg_overall_grade, count }` in chronological order.
- **Walk right-to-left**: count consecutive days where `avg_overall_grade < 5` AND `count >= 2` (the ≥2 guard prevents a lone unlucky action from tripping the revert).
- **Regressed** ⇔ streak length ≥ 7.

The threshold, minimum daily count, streak length, and lookback window are exported constants (`REGRESSION_GRADE_THRESHOLD=5`, `REGRESSION_MIN_DAILY_COUNT=2`, `REGRESSION_STREAK_DAYS=7`, `REGRESSION_LOOKBACK_DAYS=14`).

## Action (only when regressed AND current mode='armed')

1. Flip `iteration_policies` to `mode='shadow'` via [[./media-buyer__mode-flip]] `flipMediaBuyerPolicyMode(admin, workspaceId, "shadow")` — the same compare-and-set the owner disarm route uses (scoped `status='active' AND campaign_id IS NULL`).
2. Record one [[../tables/director_activity]] row `action_kind='media_buyer_self_disarmed'` under `director_function='growth'` (spec_slug `media-buyer-self-correcting-mode-revert`) with metadata `{ reason:'regression_auto_disarm', streak_days, avg_overall_grade, threshold:5, meta_ad_account_id, updated_policy_ids, autonomous:true }`.
3. Route to the CEO via [[./platform-director]] `escalateDiagnosisToCeo` with:
   - `escalationKind = "media_buyer_regressed_disarmed"`
   - `dedupeKey = "media_buyer_regressed_disarmed:{workspace_id}:{account_id|_workspace_}"`
   - `deepLink = "/dashboard/growth/media-buyer"`

The `escalateDiagnosisToCeo` dedupe is dashboard-notification-scoped (not the activity ledger), so a second sweep on the same cohort does NOT surface a duplicate CEO card even though the director_activity row is re-emitted only when the disarm actually mutates.

## Exports

- `checkMediaBuyerRegressionAndDisarm(args)` — the main entry point (one cohort → an atomic detect + disarm + escalate pass).
- `detectMediaBuyerRegression(buckets, opts?)` — pure streak scorer over the DailyGradeBucket[] shape.
- `bucketGradesByDay(rows)` — pure day-averager over the {overall_grade, graded_at} shape.
- `findArmedWorkspaces(admin)` — distinct armed workspaces the cron fans out.
- `findCohortMetaAdAccountIds(admin, {workspaceId, nowIso?})` — distinct `(meta_ad_account_id | null)` cohorts per workspace, from the joined director_activity metadata over the lookback window.

## Callers

- [[../inngest/media-buyer-self-correcting]] `mediaBuyerSelfCorrectingSweep` — per-workspace pass calls `checkMediaBuyerRegressionAndDisarm` per cohort.

## Tables read (not written)

- [[../tables/iteration_policies]] (`workspace_id`, `status='active'`, `campaign_id IS NULL` → current `mode`).
- [[../tables/media_buyer_action_grades]] (`.overall_grade`, `.graded_at`) joined `!inner` on [[../tables/director_activity]] for `metadata.meta_ad_account_id` filter.

## Tables written

- [[../tables/iteration_policies]] (mode flip via [[./media-buyer__mode-flip]] compare-and-set) — ONLY when the streak trips AND current mode='armed'.
- [[../tables/director_activity]] — one `media_buyer_self_disarmed` row per successful disarm (director_function='growth').
- [[../tables/dashboard_notifications]] — one CEO-routed approval-request via `escalateDiagnosisToCeo`, deduped by `media_buyer_regressed_disarmed:{ws}:{acct|_workspace_}`.

## Gotchas

- **The ≥2 daily count guard is non-negotiable.** A single graded action on a slow day would otherwise drag an armed cohort into a spurious streak; the guard makes the detector wait until a day has enough signal to trust.
- **A tied 5.0 avg does NOT trip.** The predicate is strict `<` — a day whose per-day average sits at exactly the threshold breaks the streak. The revert is for CLEAR regression, not marginal drift.
- **A single healthy day mid-streak resets the count.** The walk goes right-to-left and stops the moment a day fails either predicate — a run of low days interrupted by a single healthy day resets to 0.
- **Idempotency comes from re-reading `mode`.** The second sweep sees `mode='shadow'` and short-circuits — the mutation itself is not required to be idempotent because the read is.
- **The disarm is workspace-wide.** v1 iteration policies are workspace-scoped rows (`campaign_id IS NULL`), so any cohort that trips flips the whole workspace to shadow. That's by design — a single sustained-regression signal is enough to warrant the CEO's attention.
- **The escalation dedupe is dashboard-scoped, not ledger-scoped.** A CEO who dismisses the card will NOT get a fresh one from the same cohort — but a fresh disarm on a DIFFERENT cohort (a new meta_ad_account_id) DOES surface a fresh card (a new dedupeKey).

## Related

[[../tables/iteration_policies]] · [[../tables/media_buyer_action_grades]] · [[../tables/director_activity]] · [[../tables/dashboard_notifications]] · [[./media-buyer__mode-flip]] · [[./media-buyer__arming-gate]] · [[./media-buyer-grader]] · [[./platform-director]] · [[../inngest/media-buyer-self-correcting]] · [[../inngest/media-buyer-grade]] · [[../specs/media-buyer-self-correcting-mode-revert]] · [[../goals/autonomous-media-buyer-supervision]] · [[../functions/growth]]
