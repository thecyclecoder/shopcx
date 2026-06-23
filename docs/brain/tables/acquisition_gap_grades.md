# acquisition_gap_grades

The Growth-director **gap→outcome grade** — one row per surfaced competitive gap, scoring the gap 1–10 and (on revision) its routed outcome. The feedback signal that trains the scouts (M5 of [[../goals/acquisition-research-engine]], [[../specs/acquisition-research-loop-grading]]). Mirrors [[storefront_campaign_grades]] exactly. Written by [[../libraries/acquisition-gap-grader]] `gradeGap`; overridden via `src/app/api/ads/acquisition/grades/[id]`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `gap_source` | `text` | — | CHECK ∈ `ad` \| `lander` — which queue the gap lives in |
| `gap_id` | `uuid` | — | the gap row id in [[ad_gap_recommendations]] / [[lander_recommendations]] (**no FK** — two possible tables) |
| `product_id` | `uuid` | ✓ | → [[products]].id · ON DELETE SET NULL · informational copy |
| `gap_type` | `text` | — | informational copy (`ad_angle`, `comparison_table`, …) — the training-signal key |
| `grade_initial` | `int` | ✓ | 1–10 · CHECK · graded when the gap is acted-on (approved \| rejected) |
| `grade_initial_reasoning` | `text` | ✓ | |
| `gap_quality` | `int` | ✓ | 1–10 · CHECK · **scored separately from outcome** — was the gap real & well-evidenced? |
| `outcome_quality` | `int` | ✓ | 1–10 · CHECK · how the resulting action performed |
| `initial_graded_at` | `timestamptz` | ✓ | |
| `grade_revised` | `int` | ✓ | 1–10 · CHECK · graded once the outcome resolves (won \| lost) · **never overwrites initial** |
| `grade_revised_reasoning` | `text` | ✓ | |
| `revised_graded_at` | `timestamptz` | ✓ | |
| `outcome_state` | `text` | — | default `approved` · CHECK ∈ `rejected` \| `approved` \| `shipped` \| `won` \| `lost` |
| `graded_by` | `text` | — | default `agent` · CHECK ∈ `agent` \| `human` |
| `overridden_by` | `uuid` | ✓ | → `auth.users`.id · ON DELETE SET NULL |
| `override_reason` | `text` | ✓ | |
| `overridden_at` | `timestamptz` | ✓ | |
| `model` | `text` | ✓ | grader model (Sonnet) |
| `input_tokens` / `output_tokens` | `int` | ✓ | default 0 |
| `cost_cents` | `numeric(10,4)` | ✓ | default 0 |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, gap_source, gap_id)` — idempotent grading; a re-run UPDATEs in place per mode, never duplicates.

**Indexes:** `(workspace_id, created_at desc)`; `(workspace_id, gap_source, gap_type)` (training-signal lookup); partial `(workspace_id) where grade_initial is not null and grade_revised is null` (pending-revision sweep).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `product_id` → [[products]].id · `overridden_by` → `auth.users`.id. (`gap_id` is intentionally FK-less — the gap lives in one of two tables.)

## Invariants
- **Gap quality scored separately from outcome** — a well-evidenced gap that lost still scores high `gap_quality`; a flimsy rejected gap scores low. The grader never rewards outcome luck.
- **Both grades persist** — `grade_revised` never overwrites `grade_initial` (the proxy-vs-reality gap stays auditable).
- **Human-overridable** — an override sets `graded_by='human'` + `overridden_by`; the agent never re-writes a human grade.
- **Trains surfacing** — [[../libraries/acquisition-gap-grader]] `loadSuppressedGapTypes` down-weights a low-graded gap_type so it stops being re-surfaced.

## RLS
Workspace-member SELECT, service-role write (mirror [[ad_gap_recommendations]]).

---

[[../README]] · [[acquisition_grader_prompts]] · [[../libraries/acquisition-gap-grader]] · [[../specs/acquisition-research-loop-grading]] · [[storefront_campaign_grades]] · [[../../CLAUDE]]
