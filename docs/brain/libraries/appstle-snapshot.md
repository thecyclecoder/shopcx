# `src/lib/appstle-snapshot.ts`

Read-only Appstle contract reader that populates [[../tables/appstle_contract_snapshots]] for the
Appstle→ShopCX migration.

**Never mutates.** `check:no-direct-appstle-mutations` scopes itself to PUT/POST/DELETE; everything
here is GET, so no allow-list entry is needed (and none should be added).

## Exports

| export | purpose |
|---|---|
| `fetchAppstleContract(ws, contractId)` | GET one contract → `{ok, raw}` / `{ok:false, error, rateLimited?}` |
| `normalizeAppstleContract(raw)` | project the raw payload into typed columns (pure, re-runnable) |
| `snapshotAppstleContract(ws, contractId, subId)` | fetch + upsert, persisting failures |
| `SnapshotLine`, `NormalizedSnapshot`, `FetchResult` | types |

## The one thing to know

`lineDiscountedPrice` is a **LINE TOTAL**, not a unit price. `effective_unit_cents` divides it by
quantity, and that is the number the migration prices against — NOT `currentPrice`, which is
pre-discount-allocation and is what our `subscriptions` mirror stores.

## Gotchas

- **HTTP 200 + HTML = route miss.** Appstle serves its admin SPA for unknown routes, so `res.ok` is
  not evidence a call succeeded. Sniffed for a leading `<`.
- **429/503 → `rateLimited: true`**, and the runner cools off (5s → 15s → 45s → 120s) rather than
  hammering. Appstle is metered as well as rate limited.
- **Failures are persisted, not skipped** — `fetch_error` set, `raw` null, so a miss is visible.
- Money is a decimal string, sometimes fractional cents; rounded on the way in.

## Runner

`scripts/_snapshot-appstle-contracts.ts` — **safe by default** (prints the population and exits;
`--run` is required to call Appstle). Resumable: a contract already snapshotted without an error is
skipped unless `--force`. `--retry-errors` re-attempts only the failures. `--limit N` bounds a run.

## Related

[[../tables/appstle_contract_snapshots]] · [[../integrations/appstle]] · [[appstle]] ·
[[../lifecycles/shopcx-subscriptions]]
