# `src/lib/commerce/shopcx-revive.ts`

**Revive or change a never-migrated Appstle sub ON SHOPCX, built from OUR OWN `subscriptions` mirror — zero Appstle calls.**

Why it exists: Dylan is uninstalling the Appstle app (2026-10-26). Active subs are migrated to
ShopCX-owned Shopify contracts by [[commerce__shopify-subscription-migrate]] `executeMigration`, but
that path needs Appstle three times (fresh read, cancel, cancel verify), refuses CANCELLED sources and
refuses a next date more than a day in the past. What stays on `billing_source='appstle'` — ~370
paused, thousands of cancelled, ~90 payment-troubled actives — must still be revivable after Appstle
is gone. **Rule (Dylan, 10-26): build from our mirror row, never from Appstle; no bulk Appstle
backfill of cancelled subs** (a ~26K-call backfill was explicitly refused). A row is rebuilt only when
something actually touches it.

Switch: [[appstle-retired]] (`kill_switches.node_id='appstle_retired'`). Everything here is inert
until Dylan sets it.

## Exports

| Export | Kind | What |
|---|---|---|
| `ensureShopcxEngine(ws, contractId, intent, opts?, deps?)` | async | **The chokepoint.** Switch OFF → `{ ok, contractId, engine:null }` with no lookups (callers behave exactly as before). Switch ON → resolves live id + engine; non-Appstle → passthrough; Appstle + `cancel`/`pause` → `applySubscriptionStatusTruth` on our row only (`handledLocally:true`); Appstle + anything else → `buildShopcxFromMirror`, returns the NEW contract id with `engine:'shopcx'`. Typed failure `{ ok:false, reason, error }`. |
| `buildShopcxFromMirror(ws, subscriptionId, intent, opts?, deps?)` | async | Plan → claim → create → record → schedule sync → carry codes → flip → re-mirror pricing. Returns `ReviveResult`. Never throws for a business outcome. |
| `planShopcxFromMirror({...})` | pure | The whole mirror → `subscriptionContractAtomicCreate` input mapping (tested without fakes). |
| `mirrorItemsToSnapshotLines(items)` | pure | `items[]` → `planMigration` lines. `price_cents` (Appstle `currentPrice`, the customer's own rate, codes excluded) is both current and effective unit price; no code allocation. |
| `targetStatusForIntent(rowStatus, intent)` | pure | `resume` → ACTIVE; `change` keeps paused/active; `change` on cancelled → `subscription_cancelled`; cancel/pause → `local_only_intent`. |
| `resolveReviveNextBillingDate(rowNext, interval, count, now, override?)` | pure | Future date kept; lapsed date **rolled forward** by the customer's cadence (`rollForwardToFutureBillingDate`, [[dunning]]); null (cancelled rows — cancel-truth nulls it) → tomorrow. |
| `pickUsableCard(methods, now, preferredId?)` | pure | First unexpired card from `getCustomerPaymentMethods` (revoked already dropped); preferred wins when usable. |
| `resolveReviveAddress({override,row,customerDefault,customerName})` | pure | First COMPLETE address (`REQUIRED_ADDRESS_FIELDS`) in Shopify `MailingAddressInput` shape. A source with no name takes `customers.first_name/last_name` (`customerName`); the address's own name wins. |
| `droppedMirrorCodes(applied_discounts)` | pure | Names of the customer `CODE_DISCOUNT`s a revive drops (all of them; structural + `Buy N` are recomputed, not listed). Surfaced as `codesDropped`. |
| `defaultReviveDeps()` / `defaultEnsureDeps()` | factory | Production I/O seams; tests inject fakes. |
| `ensureFailureText(r)` | pure | `"<reason>: <error>"` for ops that return `{ success:false, error }`. |
| `MIRROR_ROW_COLUMNS`, `REVIVE_CLAIM_STALE_MS` (10 min) | const | |

`EngineIntent = 'cancel' | 'pause' | 'resume' | 'change'`.
`ReviveFailureReason`: `needs_payment_method` · `needs_address` · `subscription_cancelled` · `local_only_intent` · `not_found` · `not_appstle` · `no_lines` · `no_pricing_rule` · `plan_blocked` · `lookup_failed` · `in_progress` · `needs_review` · `create_failed` · `record_failed` · `flip_failed`.

## What the mirror supplies (checked 2026-10-26)

| Need | Source |
|---|---|
| lines + prices | `subscriptions.items` (`variant_id`, `sku`, `quantity`, `price_cents`) → `planMigration` (SKU first, variant id second; ACV + $0 lines dropped; protection keeps its price) |
| S&S + quantity break | the active `pricing_rules` row via `loadPricingContext` — same core as `executeMigration` |
| cadence | `billing_interval` / `billing_interval_count` (upper-cased for Shopify) |
| next date | `next_billing_date`, rolled forward if lapsed |
| **delivery price** | `delivery_price_cents` — **KEPT, never zeroed** (Dylan's shipping rule; see the migrate page's "shipping charge CARRIED") |
| shipping option | `shipping_method_code` → `{ code, title }` |
| codes | **dropped** (Dylan 2026-10-26). Pricing comes from our rules (S&S + Buy 2/3) via the planner; names returned in `codesDropped` so CS can re-add one by hand |
| address | row `shipping_address` (367/370 paused, ~5% of cancelled) → `customers.default_address`; a missing first/last name is filled from the customer record. ⚠️ Appstle stored the address WITHOUT a name on 23,506 of 26,247 never-migrated rows (2026-10-29 count) — before this fill, nearly every old cancelled sub refused with `needs_address (missing lastName)`; after it, 94 still do. |
| card | **not on the row** (`payment_method_id` is NULL on Appstle rows) → the customer's Shopify payment methods via `getCustomerPaymentMethods` (`shopify_customer_id` from the row, else `customers`) |

No usable card → `needs_payment_method`; no complete address → `needs_address` (with `missing[]`).
Callers route these to the add-card / confirm-address step (portal reactivate + order-now return
409 with the reason). Never a silent failure.

## Create path — shared, not duplicated

The contract input comes from `buildMigratedContractInput` and is created with `shopifyCreateContract`
— the exact builder `executeMigration` now uses too (status carried at create, billing anchors only,
**no delivery anchors**, MSRP lines with S&S / volume / legacy discounts riding on the atomic create).
Then `shopifySyncBillingSchedule` (non-fatal). No codes are applied.

## Idempotency — claim + record, like executeMigration's attempt marker

Two columns on [[../tables/subscriptions]] (migration `20270112120000_appstle_retired_switch_and_shopcx_revive_claim.sql`):

1. **`shopcx_revive_claimed_at`** — compare-and-set claim (`where billing_source='appstle' and shopcx_revive_contract_id is null and claimed_at = <previous>`), stamped before the create. A losing concurrent revive re-reads: if the winner already flipped it reuses that contract, otherwise `in_progress`.
2. **`shopcx_revive_contract_id`** — written IMMEDIATELY after the create, before the flip. A retry adopts it (no second create, codes never re-applied).
3. A **stale** claim (>10 min) with no recorded contract means "create outcome unknown": `findCustomerContractsCreatedSince` (shared with executeMigration) — one new contract → adopt; more than one → `needs_review`; none → re-claim and create.

Row flip (CAS on `billing_source='appstle'`): `shopify_contract_id` = new bare id, `billing_source='shopcx'`,
`migrated_from_contract_id` = the old Appstle id (so old ids keep resolving via `resolveLiveContractId`),
`status` by intent, `next_billing_date`, `pause_resume_at=null` when active. Then `mirrorContractPricing`
re-mirrors `items` from the contract (non-fatal).

## Callers

- [[commerce__subscription]] — every SDK op calls `ensureShopcxEngine` right after `resolveLiveContractId` (status, skip ×2, interval, date (built on the requested date), payment method (built with the requested card), free product, swap, order-now, shipping address (built with the NEW address; a cancelled sub records the address locally only)). `subscriptionGetUpcomingOrders` refuses for a retired-Appstle sub (a read never builds). `subscriptionSendPaymentUpdateEmail` sends OUR recovery email instead of Appstle's.
- [[subscription-items]] — `subAddItem`, `subAddOneTimeGift`, `subRemoveItem`, `subChangeQuantity`, `subUpdateLineItemPrice`, `subscriptionApplyCoupon`, `subscriptionRemoveCoupon`, `subSwapVariant`.
- Portal handlers `reactivate` (intent `resume` with the chosen date; contract born ACTIVE so no vendor resume), `order-now` (Appstle branch → `subscriptionOrderNow`), `address`, `coupon`, `replace-variants` (resolves an Appstle `oldLineId` to a variant on the pre-flip row first).
- [[../inngest/dunning]] `resetBillingDateAfterDunning` → `subscriptionUpdateNextBillingDate`; [[dunning]] `cancelForTerminalNoBackup` and the win-back / auto-resume paths already use `subscriptionAction` (auto-resume now re-resolves the live id after the resume).

## Not a node

A library chokepoint invoked inline by SDK ops — not an agent-kind, cron, reactive fn or tool
executor — so it carries no heartbeat/owner of its own. Its switch is `appstle_retired`.

## Gotchas

- **Turning the switch on while Appstle is still installed and BILLING can double-charge an ACTIVE Appstle sub that gets touched** — the revive creates a live ShopCX contract and cannot cancel the Appstle one (that would be an Appstle call). Paused/cancelled rows are safe (Appstle does not bill them). Flip the switch together with the uninstall, or accept that risk for the ~90 actives.
- **Codes are dropped, never carried** (Dylan 2026-10-26, "Drop all codes"). The mirror has no usage count, so a carried code would recur forever, one-time LOYALTY codes included. Grandfathering still applies: it is measured on the line's pre-code `currentPrice`, exactly as in `executeMigration`.
- **No pricing verify step** (executeMigration verifies before its irreversible Appstle cancel; here there is no cancel and the contract IS the charge). The plan is the same pure core; `mirrorContractPricing` re-mirrors what Shopify actually holds.
- **Open dunning cycles** are keyed by the old `shopify_contract_id`; a payment-troubled active rebuilt here leaves its Appstle-era cycle behind.
- Shipping protection as a row FLAG (`shipping_protection_added`) is not synthesized into a line — Appstle rows carry protection as a line item, which the planner keeps.

## Tests

`npm run test:commerce-shopcx-revive` (`src/lib/commerce/shopcx-revive.test.ts`, 23 cases): mapping (delivery price kept, lapsed date rolled forward), routing on/off, idempotency (reuse, concurrent, adopt, stale-claim orphan adopt), typed refusals, and a global fetch trap proving zero Appstle calls.

## Related

[[appstle-retired]] · [[commerce__shopify-subscription-migrate]] · [[commerce__subscription]] · [[../lifecycles/shopcx-subscriptions]] · [[../integrations/appstle]] · [[../tables/kill_switches]] · [[../tables/subscriptions]]
