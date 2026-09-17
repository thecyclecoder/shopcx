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
- **Steps:** `sleep 3m` → kill-switch → `ingestShopifyContract` → heartbeat
- **Heartbeat:** `emitReactiveHeartbeat("shopcx-contract-ingest", { produced: { outcome } })` on
  every run, ingested or skipped — a skip is the common, healthy case (it means one of our own rails
  owns the contract), so beating only on success would read as a dead node.

### `shopcx-contract-sync`
- **Trigger:** event `shopify/subscription-contract-updated`
- **Retries:** 2 · **Concurrency:** `{ limit: 4 }`
- **No sleep** — an update names a contract that already exists, so there is no create race to wait
  out; and if no row exists yet, `syncShopifyContract` falls through to a full ingest whose own claim
  check does the same job. That fallthrough is also what recovers a contract whose `create` webhook
  was lost.

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
