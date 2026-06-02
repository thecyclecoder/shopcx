# daily_analysis_reports

AI-generated daily analysis reports for the dashboard.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `date` | `date` | — |  |
| `analyzed_count` | `int4` | — | default: `0` |
| `avg_score` | `numeric` | ✓ |  |
| `action_items_count` | `int4` | — | default: `0` |
| `admin_corrected_count` | `int4` | — | default: `0` |
| `worst_score` | `int4` | ✓ |  |
| `best_score` | `int4` | ✓ |  |
| `summary` | `text` | ✓ |  |
| `themes` | `jsonb` | — | default: `'[]'` |
| `recommendations` | `jsonb` | — | default: `'[]'` |
| `proposed_sonnet_prompt_ids` | `uuid[]` | — | default: `'{}'` |
| `proposed_grader_prompt_ids` | `uuid[]` | — | default: `'{}'` |
| `model` | `text` | ✓ |  |
| `input_tokens` | `int4` | ✓ |  |
| `output_tokens` | `int4` | ✓ |  |
| `cost_cents` | `numeric` | ✓ |  |
| `generated_at` | `timestamptz` | — | default: `now()` |
| `generated_by` | `text` | ✓ |  |
| `trigger` | `text` | — | default: `'cron'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("daily_analysis_reports")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("daily_analysis_reports")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
