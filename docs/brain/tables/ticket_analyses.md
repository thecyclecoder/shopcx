# ticket_analyses

Per-ticket AI analysis output — sentiment, intent, summary, suggested action. Writes only through the typed SDK ([[../libraries/ticket-analyses]]), not raw `.from('ticket_analyses')` mutations. Enforced by compliance check [scripts/_check-pm-sdk-compliance.ts](https://github.com/thecyclecoder/shopcx/blob/main/scripts/_check-pm-sdk-compliance.ts).

**Primary key:** `id`

## SDK

[[../libraries/ticket-analyses]] — typed `TicketAnalysis` shape + `getAnalysis(ticketId)`, `insertAnalysis(data)`, `listForTicket(ticketId)`, `updateAnalysis(id, data)`. Every read/write flows through this SDK.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `ticket_id` | `uuid` | — | → [[tickets]].id |
| `window_start` | `timestamptz` | — |  |
| `window_end` | `timestamptz` | — |  |
| `score` | `int4` | ✓ |  |
| `issues` | `jsonb` | ✓ | default: `'[]'` |
| `action_items` | `jsonb` | ✓ | default: `'[]'` |
| `summary` | `text` | ✓ |  |
| `admin_score` | `int4` | ✓ |  |
| `admin_score_reason` | `text` | ✓ |  |
| `admin_corrected_at` | `timestamptz` | ✓ |  |
| `admin_corrected_by` | `uuid` | ✓ |  |
| `model` | `text` | ✓ |  |
| `input_tokens` | `int4` | ✓ | default: `0` |
| `output_tokens` | `int4` | ✓ | default: `0` |
| `cost_cents` | `numeric` | ✓ | default: `0` |
| `trigger` | `text` | ✓ |  |
| `ai_message_count` | `int4` | ✓ | default: `0` |
| `created_at` | `timestamptz` | ✓ | default: `now()` |

## Foreign keys

**Out (this → others):**

- `ticket_id` → [[tickets]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[grader_prompts]].`derived_from_analysis_id`

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ticket_analyses")
  .select("id, created_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Rows for a ticket
```ts
const { data } = await admin.from("ticket_analyses")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
```

### Count since a given time
```ts
const { count } = await admin.from("ticket_analyses")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

_None documented. Probe before assuming — see [[../README]] § Probing technique._

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
