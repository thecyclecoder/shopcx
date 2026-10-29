# `src/lib/appstle-retired.ts`

The **`appstle_retired`** switch — "Appstle is gone; never call it again."

## Where it lives

A row in [[../tables/kill_switches]] with `node_id = 'appstle_retired'`. That table's polarity is
"a row means the node is switched OFF", so the row means **the Appstle engine is switched off —
retired**. **Missing row ⇒ Appstle live ⇒ production unchanged.** Shipped OFF (no row) by
`supabase/migrations/20270112120000_appstle_retired_switch_and_shopcx_revive_claim.sql`.

Turn ON (Dylan, with the uninstall):

```sql
insert into public.kill_switches (node_id, scope, off_by, reason)
values ('appstle_retired', 'tool', 'ceo', 'Appstle uninstalled — revive builds on ShopCX from mirror')
on conflict (node_id) do nothing;
```

Turn OFF: `delete from public.kill_switches where node_id = 'appstle_retired';`

⚠️ It is **not** a registered node in [[control-tower-node-registry]], so the Control Tower switch
route (`POST /api/developer/control-tower/switch`) rejects it — flip it with the SQL above.
⚠️ Only the node's **own** row counts — no ancestor cascade. A CEO freezing a department must never
silently re-route billing engines.

## Exports

| Export | What |
|---|---|
| `APPSTLE_RETIRED_SWITCH` | `'appstle_retired'` |
| `isAppstleRetired()` | Reads via `loadKillSwitchMap` ([[kill-switch-resolver]], the table's read SDK), 30s per-process cache. **Fail-open**: a read error → `false` (Appstle calls then fail on their own — loud, not silent). |
| `assertAppstleLive(where)` | Throws `AppstleRetiredError` when on. |
| `AppstleRetiredError` / `isAppstleRetiredError(e)` | `code = 'appstle_retired'`; message names the call site and says to go through the commerce SDK. |
| `invalidateAppstleRetiredCache()` | Drop the cache after writing the row from a script. |
| `_setAppstleRetiredForTests(v)` | Test seam. |

## Who reads it

**Rebuild instead (the chokepoint):** [[commerce__shopcx-revive]] `ensureShopcxEngine` — every SDK op and `sub*` item op; Appstle cancel/pause become local-only, everything else is rebuilt on ShopCX from our mirror.

**Fail LOUDLY (a path the chokepoint missed):**
- [[appstle]] `getAppstleCredentials` — the first call of every `appstle*` wrapper.
- [[subscription-items]] `getAppstleConfig` — every Appstle arm of the item ops, `resolveContractVariantId`, `subscriptionGetLiveContract`.
- [[appstle-call-log]] `loggedAppstleFetch` — the lowest common Appstle fetch (only for `appstle.com` URLs).
- [[appstle-pricing]] `getAppstleKey` + `healOnTouch` (rethrows `AppstleRetiredError` instead of swallowing it as a non-fatal heal hiccup).
- [[commerce__subscription]] `defaultUpdateShippingAddressDeps().getVendorApiKey`.
- [[migrate-to-internal]] catches it and treats Appstle as unconfigured, so ShopCX rows still migrate and Appstle rows report the refusal.

**Skip cleanly (scheduled Appstle-only work):** [[commerce__shopify-subscription-migrate]] `sweepIncompleteMigrations` (returns `[]`) + `executeMigration` (`stage:'appstle-retired'`) · [[appstle-snapshot]] `snapshotAppstleContract` (`{ skipped:true }`, writes no row) + `scripts/_snapshot-appstle-contracts.ts` (exits 0) · [[migration-audit]] `verifyAppstleCancelled` (passes as "appstle_retired — skipped", so `migration-audit-retry-cron` doesn't error) · [[migration-fix]] `appstle_cancel` fix (ok, skipped).

## Still fail-loud (not routed — listed so nobody is surprised)

- Portal `loyalty-apply-subscription` Appstle arm — its first step is `healOnTouch`, which throws `AppstleRetiredError` for an Appstle sub, so it fails before the raw key read + `applyDiscountWithReplace`. Route it through `subscriptionApplyCoupon` when next touched.
- `action-executor` `healOnTouch` (line ~3902) and `subscriptionGetLiveContract` → throw `AppstleRetiredError` for an Appstle sub.
- Billing-attempt-id ops (`subscriptionAttemptBilling`, `subscriptionUnskipOrder`, dunning card rotation / payday retry on Appstle subs) — there is no contract to rebuild from an attempt id; they throw.
- The Appstle webhook route and `research/probes/subscription.ts` read the key directly (inbound / diagnostic only).

## Tests

`npm run test:appstle-retired` (`src/lib/appstle-retired.test.ts`): each wrapper throws before any
request, the sweeper / snapshot / executeMigration skip, and the gate is open when the switch is off.

## Paths gated on the switch (added 2026-10-29)

- `subscriptionGetLiveContract` returns `internal: true` (empty lines) unless the sub is Appstle-billed AND
  Appstle is live — the agent's variant-driven `remove_item` then hands off to `subRemoveItem`. This also
  fixes ShopCX subs, which used to fall through to an Appstle fetch of a Shopify contract id.
- Agent `update_shipping_address` skips `healOnTouch` when retired (the SDK call rebuilds on ShopCX).
- Portal loyalty apply treats a retired-Appstle sub as the internal arm (`subscriptionApplyCoupon`).
- `dunningUnskip` returns early on an Appstle sub when retired.
- The Appstle webhook route acks with `{ ignored: "appstle_retired" }` and processes nothing.
- `portal-auto-resume` stops retrying a resume refused for a missing card/address ([[../inngest/portal-auto-resume]]).

## Settings button (2026-10-29)

Settings > Subscriptions shows an **Appstle** card (owner only): the current state, the count of ACTIVE
subs still billed by Appstle, and a Retire / Restore button. It calls
`GET|POST /api/workspaces/[id]/appstle-retired` (`src/app/api/workspaces/[id]/appstle-retired/route.ts`), the
switch's only code writer (allowlisted in `scripts/_check-kill-switch-writer.ts`): ON upserts the row, OFF
deletes it, both invalidate the caches and write a `director_activity` `kill_switch_toggle` row. The SQL
above still works.
