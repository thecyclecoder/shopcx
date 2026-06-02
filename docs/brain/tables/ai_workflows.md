# ai_workflows

AI-callable workflows (e.g. marketing_signup). Discoverable by the Sonnet orchestrator and referenced by `tickets.ai_workflow_id`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | — |  |
| `description` | `text` | ✓ |  |
| `enabled` | `bool` | — | default: `false` |
| `trigger_intent` | `text` | — |  |
| `priority` | `int4` | — | default: `0` |
| `match_patterns` | `text[]` | ✓ | default: `'{}'` |
| `match_categories` | `text[]` | ✓ | default: `'{}'` |
| `response_source` | `text` | — | default: `'macro'` |
| `preferred_macro_id` | `uuid` | ✓ | → [[macros]].id |
| `preferred_kb_ids` | `uuid[]` | ✓ | default: `'{}'` |
| `allowed_actions` | `jsonb` | — | default: `'[]'` |
| `post_response_workflow_id` | `uuid` | ✓ | → [[workflows]].id |
| `config` | `jsonb` | — | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `channels` | `text[]` | ✓ | default: `'{}'` |

## Foreign keys

**Out (this → others):**

- `post_response_workflow_id` → [[workflows]].`id`
- `preferred_macro_id` → [[macros]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[tickets]].`ai_workflow_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ai_workflows")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("ai_workflows")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Distinct from `workflows` (deterministic templates). These are AI-callable actions the agent can offer (e.g. marketing_signup).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
