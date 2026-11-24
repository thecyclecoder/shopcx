# shopping_agent_calls

The supervision log for the public AI shopping-agent MCP server ([[../libraries/shopping-agent]]). One row per MCP tool call — the "answers to a supervisor" half of the supervisable-autonomy trio (the CMO owns the node, the kill switch stops it, this log makes every call visible). Phase 2 of the AI-shopping-agent build.

**No shopper health text is ever persisted.** Args are REDACTED to coarse, non-health fields only (e.g. `product_id`, `pack_tier`, `has_situation:true`) — never the raw situation/question text. Writes go through [[../libraries/shopping-agent]] `logShoppingAgentCall` (best-effort; never throws).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `platform` | `text` | — | `chatgpt` \| `claude` \| `grok` \| `other` (from `initialize.clientInfo` / User-Agent) · default `other` |
| `tool` | `text` | — | The MCP tool invoked (`search_products`, `find_products_for_situation`, …) |
| `args` | `jsonb` | — | REDACTED args — no free-text health details · default `{}` |
| `result_product_ids` | `uuid[]` | — | Product ids the call surfaced · default `{}` |
| `blocked_claim_count` | `integer` | — | Quotes/sentences the compliance module dropped on this call · default `0` |
| `latency_ms` | `integer` | ✓ | Request latency |
| `created_at` | `timestamptz` | — | default `now()` |

## Indexes

- `shopping_agent_calls_ws_created_idx` — `(workspace_id, created_at desc)`
- `shopping_agent_calls_platform_idx` — `(workspace_id, platform, created_at desc)`

## RLS

Enabled. `authenticated` SELECT; `service_role` ALL. Writes are service-role via the SDK.

## Migration

`supabase/migrations/20270125130000_shopping_agent_calls.sql`

## Related

[[../libraries/shopping-agent]] · [[../integrations/ai-assistant-mcp]] · [[product_customer_situations]]
