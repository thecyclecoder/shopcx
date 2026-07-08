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
| `sol_max_resessions` | `integer` | ✓ | default: `3` · **NULL = uncapped** (per the parent goal's "never rewards ... but bounds re-sessions" language — a workspace can opt out). Read by the router (Phase 2 of [[../specs/sol-runaway-re-session-cap-guardrail]]) — when [[ticket_directions]].`resession_count >=` this value, the next inflection SKIPS the fresh Sol dispatch and escalates the ticket to the routine lane with `escalation_reason='sol_resession_cap_hit'` instead. |
| `sol_cap_hit_alarm` | `integer` | — | default: `5` · Phase 3 alarm threshold for the CS Director digest's cap-hit `early_warning` storyline (Fix 1 of [[../specs/sol-runaway-re-session-cap-guardrail]]). When the rolling 7-day count of `ticket_resolution_events` rows with `reasoning='sol:cap-hit'` STRICTLY EXCEEDS this value, [[../libraries/cs-director-digest]] emits one `early_warning` storyline into the next composed [[cs_director_digests]] row so June sees it in the next digest cycle. |

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

- **`sol_max_resessions` NULL semantics:** NULL is **uncapped**, not "use the default". A workspace that wants the guardrail off explicitly sets it to NULL; a workspace that wants the default keeps the column-level default (`3`). The router's cap check is `sol_max_resessions IS NOT NULL AND resession_count >= sol_max_resessions` — a NULL never triggers the cap branch regardless of `resession_count` (Phase 2 of [[../specs/sol-runaway-re-session-cap-guardrail]]).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
