# acquisition_grader_prompts

The **calibration store** for the acquisition gap grader — Growth-director-approved adjustments to the rubric, the same arc as [[grader_prompts]] (ticket grader) and [[storefront_grader_prompts]] (campaign grader). Only `status='approved'` rules are injected into the grader's system prompt. M5 of [[../goals/acquisition-research-engine]] ([[../specs/acquisition-research-loop-grading]]). Written by [[../libraries/acquisition-gap-grader]] (large initial-vs-revised gap) + the override route; approved by the Growth director.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `title` | `text` | — | short rule title |
| `content` | `text` | — | the rule (1–3 sentences) injected into the grader prompt |
| `status` | `text` | — | default `proposed` · CHECK ∈ `proposed` \| `approved` \| `rejected` \| `archived` — only `approved` calibrates |
| `derived_from_gap_source` | `text` | ✓ | CHECK ∈ `ad` \| `lander` — provenance |
| `derived_from_gap_id` | `uuid` | ✓ | the gap that spawned the rule (no FK — two tables) |
| `derived_from_grade_id` | `uuid` | ✓ | → [[acquisition_gap_grades]].id · ON DELETE SET NULL |
| `proposed_at` | `timestamptz` | ✓ | default `now()` |
| `reviewed_at` / `reviewed_by` | `timestamptz` / `uuid` | ✓ | |
| `sort_order` | `int` | ✓ | default 100 — injection order |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Indexes:** `(workspace_id, status)`.

## RLS
Workspace-member SELECT, service-role write.

---

[[../README]] · [[acquisition_gap_grades]] · [[../libraries/acquisition-gap-grader]] · [[../specs/acquisition-research-loop-grading]] · [[storefront_grader_prompts]] · [[grader_prompts]] · [[../../CLAUDE]]
