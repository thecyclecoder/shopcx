# libraries/media-buyer-grader

Media Buyer grader — scores each concluded Media Buyer action against realized ROAS (media-buyer-test-winner-loop Phase 3). Extends the box grading cascade (mirrors [[storefront-campaign-grader]] / [[agent-grader]]) with a DETERMINISTIC grader — no Max session, no LLM. The scoring is straightforward math against the active policy's thresholds.

**File:** `src/lib/media-buyer/grader.ts` · **Runner:** [[builder-worker]] `runMediaBuyerGradeJob` (scripts/builder-worker.ts, `media-buyer-grade` lane).

## The two orthogonal quality axes

Every grade carries TWO scores, each 1–10:

- **decision_quality** — was the CALL SOUND given what the Media Buyer could see AT DECISION TIME? A promote on a strong-ROAS winner scores high here even if the realized ROAS later regressed.
- **outcome_quality** — did the REALIZED ROAS (resolved AT GRADING TIME, ≥ 3 days after the action's `created_at`) actually support the call? Independent of decision quality.

`overall_grade` is the simple `round((decision + outcome) / 2)` — legible roll-up.

**The rubric's discipline** (spec's own words): "a sound call that regressed on a later ROAS shift still grades well." Kept as an axiom in the scoring — a promote whose decision-time ROAS was 5.0 (clear-margin winner) and whose realized ROAS regressed to 1.0 still gets `decision_quality=10` + `outcome_quality=3`; the sound decision is credited even when the ad decayed.

## Realized attribution window

The grader resolves the source `meta_ad_id`'s attribution from [[../tables/meta_attribution_daily]] over the SETTLED window `[action.created_at + 3d, action.created_at + 10d]`. Two knobs:

- `REALIZED_WINDOW_MIN_DAYS = 3` — how long after the action to wait before scoring. Below this the outcome is unsettled (Meta's late attribution + first-touch backfill).
- `REALIZED_WINDOW_MAX_DAYS = 10` — outer bound so a very slow ad doesn't dominate the outcome score.

A null realized-attribution result is INFORMATION — for a `paused_loser`, no realized spend in the window IS the correct signal (the pause held), which grades `outcome_quality=10`. For a promoted winner, no realized attribution grades `outcome_quality=4` (the scaled creative didn't sustain spend).

## Exports

### `REALIZED_WINDOW_MIN_DAYS` / `REALIZED_WINDOW_MAX_DAYS` — const

`3` / `10` — the settled window bounds. See above.

### `GRADEABLE_ACTION_KINDS` — const

`["media_buyer_promoted_winner", "media_buyer_paused_loser", "media_buyer_replenished_test_cohort", "media_buyer_fatigue_replenish_triggered"]`. The exact set of [[../tables/director_activity]] action_kinds the grader knows how to score. Any other kind is skipped.

### `MediaBuyerGrade` — interface

The typed grade the pure scorer emits: `{ actionKind, sourceMetaAdId, decisionRoas, realized, decisionQuality, outcomeQuality, overallGrade, reasoning }`.

### `RealizedAttribution` — interface

`{ spendCents, revenueCents, roas, windowStart, windowEnd }`. Rolled up from [[../tables/meta_attribution_daily]] for one source `meta_ad_id` over the settled window.

### `scoreMediaBuyerAction(action, policy, realized)` — function

Pure. Given the decision-time action row + the active policy + realized attribution (or null), returns the typed grade. No DB, no side effects. This is the testable core — unit tests hit this directly without Supabase.

### `loadRealizedAttribution(admin, args)` — function

Reads [[../tables/meta_attribution_daily]] for one source `meta_ad_id` over `[action + minDays, action + maxDays]` (UTC days). Returns `null` on error, `{spendCents:0, revenueCents:0, roas:null}` when the window is empty (that IS the correct signal for a paused loser).

### `DahliaCopyMode` — type

`'author' | 'deterministic'`. The M3 measurement-lane split on [[../tables/media_buyer_action_grades]] (`dahlia_copy_mode`), stamped at grade time. NULL as a grade-row value is the pre-migration state (backfilled by `scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts`) or an unresolvable off-platform ad — per-mode readers ([[media-buyer-insights]] `getPerCopyModeCtrCac`) EXCLUDE NULLs.

### `resolveDahliaCopyMode(admin, {workspaceId, metaAdId})` — function

Joins the source Meta ad id back to `ad_publish_jobs.meta_ad_id → ad_publish_jobs.campaign_id → ad_campaigns.author_self_score`. Returns `'author'` when `author_self_score` is non-null, `'deterministic'` when null, and `null` when the Meta ad has no [[../tables/ad_publish_jobs]] row (legacy/off-platform — the grade row's mode stays NULL).

### `gradeMediaBuyerActions(admin, opts)` — function

The runner's chokepoint. Reads every UNGRADED media-buyer [[../tables/director_activity]] row older than `REALIZED_WINDOW_MIN_DAYS`, resolves realized attribution per row, stamps the [[../tables/media_buyer_action_grades]] `dahlia_copy_mode` split via `resolveDahliaCopyMode`, scores, and UPSERTS one grade row per action_id keyed on `director_activity_id`.

**Guards** (per the coaching + spec discipline):
- Idempotent — the UNIQUE index on `(director_activity_id)` collapses re-runs.
- Compare-and-set — the write does `.select("id")` and skips when zero rows transitioned so a concurrent grader can't silently no-op.
- Filters ACTIVE scope — only reads `director_activity` rows whose `action_kind` is in `GRADEABLE_ACTION_KINDS`, no bare ledger match.
- No active policy → NO grades emitted (`{ graded: 0, skipped: 0, errors: 0, grades: [] }`). Grading a null-policy action set is a category error.

Returns `{ graded, skipped, errors, grades: Array<{directorActivityId, grade}> }`.

## Scoring rubric per action_kind

### `media_buyer_promoted_winner` + `media_buyer_fatigue_replenish_triggered`

**decision_quality** (was the promote sound?)
| Decision-time ROAS vs `scale_up_roas_trigger` | Score |
|---|---|
| ≥ trigger × 1.5 | 10 (clear-margin winner) |
| ≥ trigger × 1.2 | 9 (comfortable margin) |
| ≥ trigger | 7 (thin margin) |
| < trigger | 3 (promote should not have fired) |
| missing | 4 (can't judge) |

**outcome_quality** (did the ad sustain?)
| Realized ROAS vs `scale_up_roas_trigger` / `roas_floor` | Score |
|---|---|
| ≥ trigger | 10 (scale-up held its edge) |
| ≥ floor but < trigger | 7 (regressed off winner, above pause line) |
| < floor | 3 (post-action underperform) |
| no realized attribution | 4 (didn't sustain spend) |

### `media_buyer_paused_loser`

**decision_quality** (was the pause sound?)
| Decision-time ROAS vs `roas_floor` | Score |
|---|---|
| ≤ floor × 0.5 | 10 (deep underperform) |
| ≤ floor × 0.75 | 8 (clear underperform) |
| < floor | 6 (marginal) |
| ≥ floor | 3 (pause should not have fired) |

**outcome_quality** (did the pause hold?)
- No realized spend in the settled window → 10 (correct, pause held).
- Spend + realized ROAS ≥ floor → 7 (was unpaused correctly, recovered).
- Spend + realized ROAS < floor → 5 (either unpaused too soon or attribution leaked past the pause).

### `media_buyer_replenished_test_cohort`

- **decision_quality** — defaults to 8. Replenish is a supply-side call; if the cohort was in deficit (which the runner checks) the call is sound.
- **outcome_quality** — scored like a promote against realized ROAS (the new ad should clear the floor).

## Callers

- [[builder-worker]] `runMediaBuyerGradeJob` — the box worker's `media-buyer-grade` lane. Deterministic-Node lane, concurrency-1. `job.instructions.limit` caps per-pass row count (default 50).

## Gotchas

- **Grades read REALIZED ROAS, not the pre-launch projection.** The scorer uses `realized.roas` (from meta_attribution_daily) as the outcome axis; it NEVER re-reads the decision-time ROAS to score the outcome. The spec calls this out explicitly, and the unit test at `grader.test.ts` proves it (a decision-time ROAS of 5.0 with realized 0.5 → LOW outcome_quality).
- **Deterministic (no LLM).** Unlike [[storefront-campaign-grader]] (Opus reasoning), this scorer is straightforward math. The scoring band is legible in the codebase; a Growth Director override lands via `graded_by='human'` on the same row.
- **`director_activity` is immutable to the grader.** The grade lives in `media_buyer_action_grades`, keyed by `director_activity_id`; the source row is never mutated.
- **A settled null is a signal, not a gap.** A paused loser with zero realized spend earns `outcome_quality=10`, not 4 — the pause worked. Only for scale-up / replenish does a null realized attribution mean "didn't sustain."
- **No active policy → grader is a no-op.** Grading without the thresholds that produced the decisions in the first place is a category error; the runner records nothing.

## Related

[[../tables/media_buyer_action_grades]] · [[../tables/director_activity]] · [[../tables/meta_attribution_daily]] · [[../tables/iteration_policies]] · [[media-buyer-agent]] · [[builder-worker]] · [[storefront-campaign-grader]] · [[agent-grader]] · [[../specs/media-buyer-test-winner-loop]] · [[../functions/growth]]
