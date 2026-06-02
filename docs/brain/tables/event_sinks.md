# event_sinks

Downstream destinations for storefront events — meta_capi, tiktok_events, google_enhanced, klaviyo, custom. Encrypted credentials.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `sink_type` | `text` | — |  |
| `name` | `text` | — |  |
| `is_active` | `bool` | — | default: `true` |
| `config` | `jsonb` | — | default: `'{}'` |
| `event_types` | `text[]` | — | default: `'{}'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[event_dispatches]].`sink_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("event_sinks")
  .select("id, name, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("event_sinks")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
