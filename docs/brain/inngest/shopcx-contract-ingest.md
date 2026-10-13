# inngest/shopcx-contract-ingest

Adopts Shopify-born subscription contracts — a PDP checkout with a selling plan — into
`subscriptions`. **File:** `src/lib/inngest/shopcx-contract-ingest.ts` · logic:
[[../libraries/commerce__shopcx-contract-ingest]].

## ⭐ Why this is a delayed job and not inline in the webhook

We create contracts ourselves too — the Appstle migration and the one-time-charge rail both call
`subscriptionContractAtomicCreate`, and Shopify fires `subscription_contracts/create` for those
exactly as it does for a PDP checkout. Each rail stamps its claim marker milliseconds after the
create, but **the webhook can arrive first**. Ingesting inline would race: a migrated customer
duplicated into a second row, or a $1 one-time charge reborn as a recurring subscription.

Sleeping 3 minutes first makes the claim check honest. It also lets `orders/create` land the
customer row for the same checkout, so ingestion joins to it instead of minting a duplicate
customer. The cost of waiting is a few minutes before a new subscriber shows in the portal; the cost
of not waiting is a corrupted row on a money path.

## Functions

### `shopcx-contract-ingest`
- **Trigger:** event `shopify/subscription-contract-created` (sent by the Shopify webhook route)
- **Retries:** 3 · **Concurrency:** `{ limit: 4 }`
- **Steps:** `sleep 3m` → kill-switch → `ingestShopifyContract` → `normalize-pricing` (only when
  ingested) → heartbeat
- **`normalize-pricing`** calls `shopcxNormalizeNewContract` ([[../libraries/commerce__shopcx-line-ops]]).
  A checkout contract arrives with the selling plan's 25% baked into the unit price and **no quantity
  break**, because Shopify's automatic discounts (Buy 2/3) run only at checkout and never on an
  app-led billing attempt. Without this step a Buy 2/3 subscriber gets the break on the first order
  only, and the first portal edit applies 25% again on top of the baked price. The step rebases rule lines to
  MSRP and adds "Subscribe & Save" + "Volume discount" in one draft. A failure is logged, not
  thrown: the row is already ingested and billable, just at the plan price.
  The normalizer shipped with no caller and was wired here on 2026-10-08 ahead of the product-page cutover.
- **Heartbeat:** `emitReactiveHeartbeat("shopcx-contract-ingest", { produced: { outcome, normalized, normalize_failed } })` on
  every run, ingested or skipped — a skip is the common, healthy case (it means one of our own rails
  owns the contract), so beating only on success would read as a dead node.

### `shopcx-contract-sync`
- **Trigger:** event `shopify/subscription-contract-updated`
- **Retries:** 2 · **Concurrency:** `{ limit: 4 }`
- **No sleep** — an update names a contract that already exists, so there is no create race to wait
  out; and if no row exists yet, `syncShopifyContract` falls through to a full ingest whose own claim
  check does the same job. That fallthrough is also what recovers a contract whose `create` webhook
  was lost.
- **Never normalizes.** A line pinned below MSRP on purpose (agent price restore) carries no
  allocation either, so running the normalizer on every update would undo the pin. ⚠️ So a contract
  recovered through this fallthrough is NOT normalized. Run `shopcxNormalizeNewContract` by hand
  for it.

## Node completeness

Both are registered in `MONITORED_LOOPS` (`kind: "reactive"`, `owner: "retention"`, 30h liveness) so
their kill switches resolve — an UNREGISTERED node resolves to `{off:false}`, a switch that silently
can never fire. See [[../libraries/control-tower-node-registry]].

## Tables written

- [[../tables/subscriptions]] (upsert on `workspace_id,shopify_contract_id`)
- [[../tables/customers]] (insert, last resort only)
- [[../tables/orders]] (`subscription_id` link, fills NULL only)

## Tables read (not written)

- [[../tables/appstle_contract_snapshots]] · [[../tables/one_time_charges]] ·
  [[../tables/dunning_cycles]] · [[../tables/product_variants]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
