# libraries/subscription-order-link

Links a subscription's **originating checkout order** to its [[../tables/subscriptions]] row via `orders.subscription_id`. Owner: [[../functions/cfo]] / commerce.

**File:** `src/lib/subscription-order-link.ts` · **Test:** `src/lib/subscription-order-link.test.ts` (`npm run test:subscription-order-link`) · **Backfill:** `scripts/_backfill-subscription-order-links.ts`

## What was broken (and what wasn't)

A subscription's FIRST order is an ordinary checkout: Shopify sends `source_name="web"` plus a **"first subscription" tag**. Only RENEWALS carry a `source_name` containing "subscription". The order webhook's linkage block was gated on `sourceName.includes("subscription")`, so it fired on every renewal and no first order.

**That gate is not the regression** — it was equally false in December 2025, when 159/159 `source_name="web"` first-sub orders still ended up linked. What actually filled the column was the **one-time launch import** ([[../inngest/import-subscriptions]] — an `import/file.upload` event, NOT a cron), which back-links orders as a side effect. It ran in March 2026 (~27,786 subscriptions) and, being one-time, never ran again.

So the real defect: **a routine invariant depended on a human running an import.**

### ⭐ Scope — this never affected counting

Measured on July 2026:

| | Count | Linked | Effect |
|---|---|---|---|
| Renewals | 1,833 | **1,833** | none — the Appstle `billing-success` handler links these off `data.orderId` |
| Shopify first-sub orders | 169 | 0 | **167/169 still bucket `new_sub` via the tag** |
| Internal storefront | 4 | 2 | 2 orders misbucket |

[[order-bucketing]] `bucketOrder` accepts the tag, so MRR, ROAS sub-rate and every new-sub count were **always correct**. The only consumers that need the FK are **joins** — notably the portal's per-subscription order-history widget (`portal/handlers/subscription-detail.ts`, `.eq("subscription_id", sub.id)`), which showed a new subscriber **nothing until their first renewal** ~28 days later. That widget is the user-visible symptom and the reason this shipped.

## Why both webhooks call it

The two rows come from two independent webhooks — Shopify sends the order, Appstle the subscription — with no guaranteed ordering. On the 1,013 stranded orders our `subscriptions` row was inserted after the order's Shopify timestamp in every case (1,010 within five minutes), but that is a proxy for arrival order, not proof.

Rather than depend on ordering, **both** handlers call `linkOriginatingOrder`:

- `src/app/api/webhooks/appstle/[workspaceId]/route.ts` — after the subscription upsert
- [[shopify-webhooks]] — behind the widened gate (`source_name` OR the tag)

Whichever lands second finds both rows and links; the first no-ops. The compare-and-set UPDATE (`.is("subscription_id", null)`) makes the double call safe.

## Exports

Pure (no DB, no clock — unit-pinned):

- `chooseOrderForSubscription(candidates, subItems): LinkResult` — the matching rule.
- `isFirstSubscriptionOrder(order)` — tag match, or `source_name === "storefront"` (internal orders carry no Shopify tag).
- `tagTokens(tags)` — Shopify joins tags into one comma string; also accepts an array.
- `orderSkus(lineItems)`

DB-backed:

- `linkOriginatingOrder(admin, { workspaceId, subscriptionId, shopifyCustomerId, subItems?, anchorIso? }): Promise<LinkResult>`

Constants: `LINK_LOOKBACK_MS` (24h before the subscription), `LINK_LOOKAHEAD_MS` (1h after, for clock skew).

## The matching rule

Deliberately conservative — **ambiguity is left unlinked rather than guessed**, because a wrong `subscription_id` is worse than a null one (it corrupts bucketing AND the subscription's order history):

1. SKU overlap between the order's line items and the subscription's items wins outright. Two orders sharing the SKU → the **earliest** (that's the originating one).
2. No overlap but exactly **one** eligible candidate → link it (`sole_candidate`).
3. Otherwise → `ambiguous`, no write.

`LinkResult.reason` (`sku_match` · `sole_candidate` · `no_candidate` · `ambiguous` · `error`) is returned so a wrong link is diagnosable.

## Backfill

`scripts/_backfill-subscription-order-links.ts` — dry-run by default, `--apply` to write. **Order-driven on purpose**: the March migration created ~27,786 subscriptions whose orders that same import already linked, so walking subscriptions scans 28K rows to fix ~1K. Starting from unlinked orders and fanning out to just those customers' subscriptions is ~25× less work.

**DB-only — zero external API calls.** Appstle bills per hit, so a backfill must never loop against it; our `subscriptions` table already mirrors the state.

Ran 2026-08-24: **1,088 orders linked** (942 `sku_match`, 146 `sole_candidate`, 2 ambiguous correctly skipped). A re-run finds 0 — idempotent via the compare-and-set.

## Gotchas

- **Renewals were never broken.** Don't "fix" the `billing-success` path in `webhooks/appstle` — it links 1833/1833.
- **Never widen the matcher to link on customer alone.** A customer with two subscriptions started in the same window would get an arbitrary assignment; `ambiguous` is the correct outcome.
- The lookback window is anchored on the SUBSCRIPTION's creation, not the order's — a first order precedes its subscription row.

## Related

[[order-bucketing]] · [[shopify-webhooks]] · [[../tables/subscriptions]] · [[../tables/orders]] · [[../integrations/appstle]] · [[../lifecycles/subscription-billing]]

---

[[../README]] · [[../../CLAUDE]]
