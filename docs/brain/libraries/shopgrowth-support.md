# shopgrowth-support

`src/lib/shopgrowth-support.ts`: the ShopGrowth support API client for the software-mode orchestrator
(software-mode-orchestrator-toolset). Integration details: [[../integrations/shopgrowth-support-api]].

## Exports

| Export | What |
|---|---|
| `storeKeyFromTags(tags)` / `resolveStoreKey(ticketTags, customerTags)` | `{shop, app}` from `shop:` / `app:` tags; ticket tags win |
| `buildStoreReadUrl(apiBase, key, {section, order, since})` | section → endpoint URL; unknown sections fall back to `store` |
| `compactBody(body, max)` | re-serialized JSON, capped (default `SHOPGROWTH_MAX_TEXT` = 6,000) |
| `isForbiddenShopgrowthAction(action)` | plan / billing / uninstall / data deletion → true |
| `isShopgrowthActionConfirmed(latestInbound, quote)` | verbatim quote in the latest inbound message, affirmative, no refusal words |
| `getShopgrowthConfig(admin, workspaceId)` | `{apiBase, token}` (token decrypted) or null |
| `getTicketStoreKey(admin, ticketId, customerId)` | the ticket's verified store |
| `getShopgrowthStore(admin, workspaceId, ticketId, customerId, input)` | the `get_shopgrowth_store` tool body; always returns text |
| `postShopgrowthAction(cfg, key, body)` | `{kind:'ok', summary}` / `{kind:'not_live'}` / `{kind:'failed', status, detail}` |

## Callers

- [[sonnet-orchestrator-v2]] `executeToolCall` case `get_shopgrowth_store` (software mode only).
- [[action-executor]] `executeShopgrowthAction`.

## Tests

`npm run test:shopgrowth-support` (`src/lib/shopgrowth-support.test.ts`): tag resolution, endpoint mapping, forbidden
actions, confirmation gate, software tool allow-list, software prompt shape.
