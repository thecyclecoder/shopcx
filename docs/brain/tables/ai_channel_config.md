# ai_channel_config

Per-(workspace, channel) AI agent settings — personality, confidence threshold, auto-resolve toggle, turn limit.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `channel` | `text` | — | CHECK: `email`, `chat`, `sms`, `meta_dm`, `phone`, `help_center`, `social_comments`, `portal` |
| `personality_id` | `uuid` | ✓ | → [[ai_personalities]].id |
| `enabled` | `bool` | — | default: `false` |
| `sandbox` | `bool` | — | default: `true` |
| `instructions` | `text` | — | default: `''` |
| `max_response_length` | `int4` | ✓ |  |
| `confidence_threshold` | `float8` | — | default: `0.90` |
| `auto_resolve` | `bool` | — | default: `false` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |
| `ai_turn_limit` | `int4` | — | default: `4` |
| `problem_lockin_threshold` | `numeric` | — | default: `0.7` · CHECK ∈ [0,1] · read by [[../lifecycles/ai-multi-turn]] § Confidence-gated problem lock-in — when the latest [[ticket_resolution_events]] row on a ticket has `confidence >=` this value, its `problem` is injected as `ESTABLISHED PROBLEM (locked in at T{N})` into the Sonnet system prompt. See [[../specs/confidence-gated-problem-lockin-and-selective-clarify]]. |

## Foreign keys

**Out (this → others):**

- `personality_id` → [[ai_personalities]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ai_channel_config")
  .select("id, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Count since a given time
```ts
const { count } = await admin.from("ai_channel_config")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
