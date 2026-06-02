# dunning_error_codes

Lookup table of payment gateway decline codes mapped to category + customer-facing wording.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `error_code` | `text` | — |  |
| `error_message` | `text` | ✓ |  |
| `is_terminal` | `bool` | — | default: `false` |
| `occurrence_count` | `int4` | — | default: `1` |
| `first_seen_at` | `timestamptz` | — | default: `now()` |
| `last_seen_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("dunning_error_codes")
  .select("id")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
