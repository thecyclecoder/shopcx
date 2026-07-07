# media_buyer_action_grades

Per-action grades for the Media Buyer's Test→Measure→Promote→Kill loop (media-buyer-test-winner-loop Phase 3). One row per concluded [[director_activity]] row emitted by [[../libraries/media-buyer-agent]] — the box grading cascade closes the CEO → Growth → Media Buyer chain, scoring each call against realized ROAS resolved AT LEAST 3 DAYS after the action's `created_at`.

The rubric's discipline (spec's own words): "a sound call that regressed on a later ROAS shift still grades well." The two axes are ORTHOGONAL — `decision_quality` scores the CALL at the time it was made; `outcome_quality` scores the REALIZED ROAS resolved at grading time.

**Distinct from two neighbouring concepts** — keep them straight:

- [[storefront_campaign_grades]] grades the Storefront Optimizer's campaigns at significance + at ~4-month LTV reconcile.
- [[agent_action_grades]] grades the box's WORKER JOB outputs (build/plan/spec-test/etc.) against a rubric.
- `media_buyer_action_grades` (this table) grades the Media Buyer AGENT's cadence-pass ACTIONS (promote/kill/replenish/fatigue-replenish) against realized meta_attribution_daily ROAS.

**Primary key:** `id` · **Unique key:** `director_activity_id` (one grade per action — idempotent grading).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `director_activity_id` | `uuid` | NOT NULL · UNIQUE · → [[director_activity]].id · ON DELETE CASCADE. One grade per Media Buyer action; `.upsert(onConflict='director_activity_id')` guarantees idempotency. |
| `action_kind` | `text` | The [[director_activity]] `action_kind` this grade scored. Mirrors the [[../libraries/media-buyer-grader]] `GRADEABLE_ACTION_KINDS` vocab: `media_buyer_promoted_winner` \| `_paused_loser` \| `_replenished_test_cohort` \| `_fatigue_replenish_triggered`. |
| `source_meta_ad_id` | `text?` | The creative the action cited at decision time (from the action row's `metadata.source_meta_ad_id`). |
| `decision_roas` | `numeric(10,4)?` | The ROAS the Media Buyer cited at decision time (from `metadata.roas`). Kept as-is so a re-grade doesn't lose the original signal. |
| `realized_roas` | `numeric(10,4)?` | The realized ROAS from [[meta_attribution_daily]] over `[action.created_at + 3d, action.created_at + 10d]`. NULL when the window is empty — for a `paused_loser` that IS the correct signal (the pause held), scored `outcome_quality=10`. |
| `realized_window_start` / `realized_window_end` | `date?` | The UTC bounds of the settled window this grade scored. |
| `realized_spend_cents` / `realized_revenue_cents` | `bigint?` | The rolled-up realized totals over the window. |
| `decision_quality` | `int` | NOT NULL · CHECK 1–10. Was the CALL SOUND given what the Media Buyer could see at decision time? |
| `outcome_quality` | `int` | NOT NULL · CHECK 1–10. Did the REALIZED ROAS support the call? Independent of decision_quality. |
| `overall_grade` | `int` | NOT NULL · CHECK 1–10. `round((decision + outcome) / 2)` — legible roll-up. |
| `reasoning` | `text?` | The grader's per-axis justification citing the ROAS numbers. |
| `graded_by` | `text` | NOT NULL default `'agent'` · CHECK ∈ `{agent, human}`. Growth Director override sets `human`. |
| `overridden_by` | `uuid?` | → `auth.users.id` · ON DELETE SET NULL. The workspace member who overrode (nullable). |
| `override_reason` | `text?` | Why the human overrode. |
| `overridden_at` | `timestamptz?` | |
| `graded_at` | `timestamptz` | NOT NULL default `now()` · when the grader emitted this row. |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `media_buyer_action_grades_touch_updated_at` trigger |

## Indexes

- `media_buyer_action_grades_ws_idx` — `(workspace_id, created_at desc)`. Workspace grade feed.
- `media_buyer_action_grades_kind_idx` — `(workspace_id, action_kind, graded_at desc)`. Roll-up by verb (average grade for promote vs kill vs replenish).

## Triggers

- `media_buyer_action_grades_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer:** [[../libraries/media-buyer-grader]] `gradeMediaBuyerActions` (via UPSERT on `director_activity_id`). Written from the box worker's `media-buyer-grade` lane — service role only, never client-side.
- **Reader:** future roll-ups on Growth's dashboard (roll grade averages by `action_kind` to compare promote-vs-kill quality); the Growth Director's brief; the Media Buyer's own coaching signal.

## Gotchas

- **The UNIQUE on `director_activity_id` is the idempotency guarantee.** A re-run of the grader upserts in place — never inserts a duplicate. `.select("id")` on the write asserts exactly one row transitioned per action, so a concurrent grader can't silently no-op.
- **Realized ROAS = null is INFORMATION.** For a `paused_loser`, no realized spend in the settled window IS the correct signal (the pause held), which grades `outcome_quality=10`. For a promoted winner, no realized attribution grades `outcome_quality=4` (didn't sustain). The two null-interpretations are per-verb; see [[../libraries/media-buyer-grader]].
- **`decision_roas` is FROZEN at decision time.** The scorer reads it from the action row's metadata and NEVER re-derives it — a decision that looked good at the time keeps its `decision_quality` even if the retrospective attribution says otherwise.
- **No active policy → the grader is a no-op.** The scorer requires the thresholds that produced the decisions to grade them. `gradeMediaBuyerActions` returns `{ graded: 0 }` when `loadActivePolicy` returns null.
- **A Growth Director override lives on the same row.** Flip `graded_by='human'` + set `overridden_by` + `override_reason` + `overridden_at`. The initial agent scores are preserved (no shadow columns) — a re-run of the grader will NOT clobber a human-overridden row (the write guard on `.select("id")` catches it).
- **Small at scale.** One row per Media Buyer action; with a weekly cadence + ~10 actions per workspace per pass, growth is bounded. No archival policy needed yet.

## Migration

`supabase/migrations/20260707140000_media_buyer_action_grades.sql` — apply with `npx tsx scripts/apply-media-buyer-action-grades-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS: service-role full access + workspace-member SELECT (mirrors [[storefront_campaign_grades]]).

## Related

[[director_activity]] · [[meta_attribution_daily]] · [[iteration_policies]] · [[media_buyer_test_cohorts]] · [[../libraries/media-buyer-grader]] · [[../libraries/media-buyer-agent]] · [[../libraries/builder-worker]] · [[storefront_campaign_grades]] · [[agent_action_grades]] · [[../specs/media-buyer-test-winner-loop]] · [[../functions/growth]]
