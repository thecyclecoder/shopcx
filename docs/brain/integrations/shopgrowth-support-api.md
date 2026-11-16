# ShopGrowth support API

ShopGrowth's merchant-support API, read and written by the software-mode Sonnet orchestrator
([[../libraries/sonnet-orchestrator-v2]]) on merchant-support workspaces (`workspaces.support_mode = 'software'`,
see [[../libraries/support-mode]]). Client: [[../libraries/shopgrowth-support]]. Built by
software-mode-orchestrator-toolset (goal: shopgrowth-software-support).

## Data separation

Store data lives in ShopGrowth. ShopCX fetches it live per ticket, hands it to the orchestrator as compact text
(capped at 6,000 chars per read), and never persists it outside that ticket's own AI context. Shopify access for the
merchant's store never leaves ShopGrowth: order changes are executed by ShopGrowth on our request.

## Auth

Per workspace, on [[../tables/workspaces]]:

- `shopgrowth_api_base`: the API base URL.
- `shopgrowth_support_token_encrypted`: bearer token, AES-256-GCM via [[../libraries/crypto]]. Set from the settings
  UI or a one-off encrypted write; never plaintext, never in code.

Every call sends `Authorization: Bearer <token>`. Both NULL = not connected: the read tool tells the model it can't
see store data, and actions escalate.

## Store identity

The `shop` + `app` on every call come from the ticket's verified identity tags (`shop:<domain>`, `app:<slug>`,
stamped by [[../libraries/widget-identity]]), falling back to the customer row's tags. They are **never** taken from
model input, so the model cannot read or act on another store.

## Endpoints

All take `?shop=…&app=…`. 8-second timeout. A 404 means "not available yet" (endpoint not live), not an error.

| Tool / section | Endpoint |
|---|---|
| `get_shopgrowth_store` summary (default) | `GET /api/support/v1/store` |
| `get_shopgrowth_store` events | `GET /api/support/v1/events?limit=50&since=…` (live) |
| `get_shopgrowth_store` flags | `GET /api/support/v1/events?type=flag&limit=50&since=…` |
| `get_shopgrowth_store` orders / order | `GET /api/support/v1/orders?order=#1234&since=…` |
| `get_shopgrowth_store` chargebacks | `GET /api/support/v1/chargebacks?since=…` |
| `shopgrowth_action` | `POST /api/support/v1/actions` `{shop, app, action, params, ticket_id}` → `{ok, summary}` |

## Actions (`shopgrowth_action`)

A decision type, not a tool, so it always runs through the action executor's gates
([[../libraries/action-executor]] `executeShopgrowthAction`):

1. Software mode only (refused and escalated on a cpg workspace).
2. Never plan/billing, uninstall, or data deletion (`isForbiddenShopgrowthAction`); the AI links the Plans page instead.
3. The merchant's latest inbound message must contain the model's `confirmation_quote` verbatim and read as a yes
   (`isShopgrowthActionConfirmed`). The orchestrator proposes the change one turn, acts the next.
4. ShopGrowth owns the allow-list and validation. The reply is ShopGrowth's `summary`; a non-2xx never claims success
   and escalates. A 404 (actions endpoint not live) escalates with an internal note.

## Gotchas

- The flags section reads the events endpoint with `type=flag`; until ShopGrowth honors that filter it returns all events.
- Replies still pass the executor's send guards; a summary that trips the outcome-claim guard escalates instead of sending.
