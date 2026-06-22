# `storefront_campaign_grades` — one row per graded campaign

One row per concluded M4 campaign (a [[storefront_experiments]] record), carrying the Head-of-Growth grade: an **initial** grade at significance and a **revised** grade ~4 months later when the M3 reconciler lands the cohort's actual LTV — **both persist**. The defining shape: **hypothesis quality is scored separately from result** (a sound bet that lost grades high; a lucky win from a sloppy bet grades low). Written + driven by [[../libraries/storefront-campaign-grader]]. Migration `20260628120000_storefront_campaign_grades.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] (M5). Mirrors the shipped ticket grader [[ticket_analyses]]. Spec `docs/brain/specs/storefront-campaign-grading-loop.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `experiment_id` | uuid → [[storefront_experiments]] | **UNIQUE** (one grade row per campaign → idempotent grading). cascade |
| `grade_initial` | int | 1–10 (CHECK), the proxy-time grade at significance |
| `grade_initial_reasoning` | text | the grader's reasoning for the initial grade |
| `hypothesis_quality` | int | 1–10 (CHECK) — was the BET sound at design time, **independent of result** |
| `result_quality` | int | 1–10 (CHECK) — how the campaign performed on the reward (separate axis) |
| `initial_graded_at` | timestamptz | when the initial grade landed |
| `grade_revised` | int | 1–10 (CHECK), **nullable until the cohort reconciles**; never overwrites `grade_initial` |
| `grade_revised_reasoning` | text | reasoning for the revised (actual-LTV) grade |
| `revised_graded_at` | timestamptz | when the revised grade landed |
| `graded_by` | text | `agent` \| `human` (CHECK), default `agent` — `human` once the Growth director overrode |
| `overridden_by` | uuid → auth.users | the member who overrode (nullable; `on delete set null`) |
| `override_reason` | text | why the director overrode |
| `overridden_at` | timestamptz | when the override happened |
| `model` / `input_tokens` / `output_tokens` / `cost_cents` | text/int/int/numeric | grader cost accounting (mirror [[ticket_analyses]]) |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** `(workspace_id, created_at desc)`; partial `(workspace_id) where grade_initial is not null and grade_revised is null` — the revised-grading lookup (campaigns awaiting their 4-month grade).

## Lifecycle
- **Initial grade** — fired at significance from the M4 decide step ([[../libraries/storefront-experiment-refresh]], on every terminal promote/kill/rollback). `graded_by='agent'`, the two sub-scores + reasoning land. Idempotent: a re-grade UPDATEs in place.
- **Revised grade** — once the cohort's [[storefront_ltv_reconciliations]] row exists, the M3 reconcile run ([[../inngest/storefront-ltv-reconcile]]) re-grades: `grade_revised` + reasoning fill, `grade_initial` untouched. A large initial-vs-revised gap (≥3) proposes a [[storefront_grader_prompts]] rule.
- **Override** — the Growth director overrides either axis on the funnel dashboard; `graded_by='human'`, `overridden_by`/`override_reason`/`overridden_at` recorded. The agent will not re-write a human-overridden initial grade.

## Gotchas
- **Both grades are kept.** The initial (proxy-time) grade is never overwritten by the revised (actual-LTV) one — the proxy-vs-reality gap stays auditable. They live in distinct columns.
- **Hypothesis ≠ result.** `hypothesis_quality` and `result_quality` are independent axes — the grader must not reward outcome luck. This is the goal's § grade invariant.
- **One row per campaign.** `experiment_id` is UNIQUE; grading is idempotent per mode (a re-run updates the matching columns, never inserts a duplicate).
- **Training signal.** `loadLeverGradeSignal` aggregates these into per-lever average grades that bias the M4 brief + the M2 [[storefront_lever_importance]] selector (`gradeBias`).
