# sol-stock-promise-guard

`src/lib/sol-stock-promise-guard.ts` — deterministic gate on Sol's draft reply: **never OFFER a flavor the 3PL cannot ship.** Third of the Sol send guards, alongside [[sol-policy-bait-guard]] (never bait an out-of-policy remedy) and [[sol-move-dead-end-guard]] (never end a move on a dead end).

## Why it exists

Ticket `0c9f11a7` (2026-08-28). Keira asked to reorder her usual four flavors. Sol replied:

> *"I've got your usual set right here: Superfood Tabs in Mixed Berry and Strawberry Lemonade, plus Amazing Coffee in Hazelnut and Cocoa."*

Strawberry Lemonade had been **3PL-zero since 2026-07-30**, under an ACTIVE [[../tables/crisis_events]] row. The order couldn't include it, she was billed **$213.24** anyway, and the make-good cost a free unit plus a subscription recomposition.

**Sol wasn't ignoring a warning — it had no stock signal at all.** `getCxProducts` ([[cx-agent-sdk]]), the SDK Sol is explicitly told to call, returned every active variant with `id`, `title`, `price_cents` and nothing else. A dead flavor and a shippable one rendered identically.

## The two halves of the fix

**1. Give Sol the truth** ([[cx-agent-sdk]]). `CxProductVariant` now carries `sku`, `on_hand`, and `in_stock`, joined from canonical [[../tables/inventory_levels]] via `getAmplifierOnHandBySku` — the 3PL **ship truth**, which the founder is explicit is the only authority (2026-08-28: *"the 3PL is the only true source of inventory, not Shopify"*). `formatCxProducts` tags every variant `⛔ OUT OF STOCK` / `⚠️ stock unknown` / `N on hand` and appends a `⛔ CANNOT SHIP RIGHT NOW` summary line.

> `in_stock` is **NULL when unknown**, never `false`→`true` coerced. No 3PL row means we can't vouch for it; unknown is a reason to check, not a licence to promise.

**2. Gate the draft anyway.** A prompt-visible fact is advisory — [[sol-policy-bait-guard]] exists precisely because telling an agent a rule doesn't reliably stop it breaking the rule. `assessSolStockPromiseRisk({ firstReply, outOfStock })` runs in `runTicketHandleJob` next to the other two guards; a block sets `honorBlockLine`, so the customer never sees the reply and the ticket escalates to June.

## What blocks and what passes

**BLOCKS** — naming an out-of-stock variant as something the customer is getting, with no unavailability anywhere in the reply. The incident text above blocks.

**PASSES** — naming it *as unavailable*. This is required behavior, not merely tolerated:

> *"Strawberry Lemonade is out of stock right now, so I wasn't able to include it."*

One disclosure anywhere clears the whole reply (`UNAVAILABLE_MARKERS` — out of stock · sold out · unavailable · back in stock · couldn't include · currently out · …). Matching is done on normalized text, so HTML and hyphenation (`<b>Strawberry-Lemonade</b>`) still match.

## Fails open, deliberately

- Empty reply, or empty OOS list → no block.
- Variant names under 4 chars are skipped (a variant like "Ade" would collide with ordinary prose).
- Only `in_stock === false` is policed — **never** `null`, which would fire on every variant lacking a 3PL row.
- The worker wraps the lookup in try/catch: a products-read failure logs and skips the gate rather than blocking a legitimate reply.

## Related
[[cx-agent-sdk]] · [[sol-policy-bait-guard]] · [[sol-move-dead-end-guard]] · [[inventory-read]] · [[../tables/inventory_levels]] · [[../tables/product_variants]] · [[../inngest/sync-inventory]]
