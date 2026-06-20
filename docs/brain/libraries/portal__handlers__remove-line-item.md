# libraries/portal/handlers/remove-line-item

Portal remove a line item from sub.

**File:** `src/lib/portal/handlers/remove-line-item.ts`

## Exports

### `removeLineItem` — const

```ts
const removeLineItem: RouteHandler
```

## Callers

_No internal callers found via static scan._

## Gotchas

**Stale line id → variant-id fallback (fixed 2026-06-20).** `transform-subscription` sets a line's portal `id` to `line_id || variant_id` ([[../lifecycles/customer-portal]]:42), so an **Appstle** line that surfaced without a real Appstle `line_id` arrives with `id === variant_id`. The portal posts `{ lineId: ln.id, variantId: ln.variantId }`; the handler used to trust *any* present `lineId` as a SubscriptionLine GID for non-internal subs, so it called Appstle with `gid://shopify/SubscriptionLine/<variantId>` → unrecoverable `400 "Couldn't find LineId"` (`appstle_error`). Now the handler treats `lineId` as a real line GID **only** when it matches a real `line_id` on the resolved contract items (`isRealLineGid`); otherwise it falls back to **variantId** resolution, which `appstleRemoveLineItem` ([[subscription-items]]) supports via a live contract fetch. Additionally, when the numeric variant isn't on the live contract at all, `appstleRemoveLineItem` now returns `{ success: true, alreadyAbsent: true }` (idempotent "already removed") instead of the raw GID error — the handler returns `jsonOk({ alreadyRemoved: true })`, so the portal self-serves and no ticket escalates. Title-based (non-numeric) orchestrator calls keep the descriptive "not found on contract" error. From ticket `c61858db-8f9a-4076-9beb-75f51f1ff52d`.

---

[[../README]] · [[../../CLAUDE]]
