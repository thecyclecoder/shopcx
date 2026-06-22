# `storefront_grader_prompts` — campaign-grader calibration store

The human-approved calibration rules for the campaign grader (M5) — the Growth director corrects the grader's scoring on edge cases the same way the ticket grader is calibrated by [[grader_prompts]]. Only an **approved** rule is injected into the campaign grader's system prompt. A rule is born from a Growth-director override on a grade, or from a large initial-vs-revised proxy-vs-reality gap. Written + read by [[../libraries/storefront-campaign-grader]]. Migration `20260628120000_storefront_campaign_grades.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] (M5). Spec `docs/brain/specs/storefront-campaign-grading-loop.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `title` | text | short rule title |
| `content` | text | the rule itself (1–3 sentences), injected into the grader prompt when approved |
| `status` | text | `proposed` \| `approved` \| `rejected` \| `archived` (CHECK), default `proposed`. Only `approved` calibrates the grader |
| `derived_from_experiment_id` | uuid → [[storefront_experiments]] | the campaign that prompted the rule (`on delete set null`) |
| `derived_from_grade_id` | uuid → [[storefront_campaign_grades]] | the grade row that prompted it (`on delete set null`) |
| `proposed_at` | timestamptz | default now() |
| `reviewed_at` | timestamptz | set on approve/reject |
| `reviewed_by` | uuid | who reviewed |
| `sort_order` | int | default 100 — rule order in the prompt |
| `created_at` / `updated_at` | timestamptz | |

**Index:** `(workspace_id, status)` — the approved-rules-for-prompt + proposed-rules-for-review lookups.

## Lifecycle (status)
- `proposed` — drafted by Opus from a grade override (`POST /api/workspaces/[id]/storefront-campaign-grades/[gradeId]`) or a large gap on revision; awaits the Growth director. `approved` — the director approved it (funnel dashboard); now injected into `buildCampaignGraderSystemPrompt`. `rejected` / `archived` — not used.
- Approve/reject + edit + delete go through `PATCH/DELETE /api/workspaces/[id]/storefront-grader-prompts/[ruleId]`.

## Gotchas
- **Auto-applied rules are forbidden.** A proposed rule never reaches the grader until a human approves — the supervised-tool invariant ([[../operational-rules]] § North star). Mirror [[grader_prompts]].
- **Separate store from [[grader_prompts]].** The audience differs (the campaign grader, not the ticket grader); same shape, different table.
