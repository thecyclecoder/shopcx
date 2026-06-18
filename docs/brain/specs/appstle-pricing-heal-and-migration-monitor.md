# Appstle pricing heal + migration monitor ✅

> **Build status (2026-06-09): Phases 1–3 shipped.** Heal-on-touch gateway, smart migration (heal-by-migration), and the migration monitor (audit table + checklist + retry cron + `/dashboard/migrations`) are live. Resolved open questions: retry bound **N = 3** (10-min cron); dashboard at **`/dashboard/migrations`** (owner-only). **Remaining:** Phase 1b (consolidate stray direct fetches onto real wrappers) + the standalone integrity sweep — both ⏳ below. New code lives in [[../libraries/appstle-pricing]], [[../libraries/migration-audit]], [[../tables/migration_audits]].

**Goal:** make every Appstle subscription structurally correct (a real `pricingPolicy` with base price + S&S cycle discount) before we ever act on it, migrate subs to internal with *provably correct* pricing, and **monitor that the post-payment-method actions (migration, cancel, immediate charge) happen flawlessly** — because the one thing we cannot lose is "free" renewal revenue.

**Why now:** Appstle's original migration collapsed "$79.95 base − 25% off" into a flat low price (`pricingPolicy: null`) on a chunk of our subs. Those subs don't re-apply the 25% on modification (legacy portal), and they're a landmine for our internal pricing engine (`base × (1−break) × (1−sns)`) — if we treat their already-discounted flat price as a base, we double-discount and bleed revenue. We've now (a) confirmed the Appstle API can add a pricing policy to a null-policy sub, and (b) validated it live on a real failed-payment customer (huntb1@cox.net).

Designed in a working session 2026-06-09. Decisions below are settled.

## Validated facts (don't re-derive)

- **The detection signal is `line.pricingPolicy`** on the Appstle contract:
  - present (`basePrice` + `cycleDiscounts`) → structured S&S; `basePrice` is the true base; `currentPrice = basePrice × (1 − cycle%)`.
  - `null` → Appstle "baked-in" flat price; no discount structure; `currentPrice` is what they pay, period.
- **Endpoint to heal:** `PUT /api/external/v2/subscription-contracts-update-line-item-pricing-policy`
  - Query: `contractId` (int), `lineId` (full GID, **required — no all-lines variant**), `basePrice` (number). Header `X-API-Key`.
  - Body = cycles array (max 2): `[{ "afterCycle": 0, "discountType": "PERCENTAGE", "value": 25 }]`. `afterCycle: 0` = from the first order. `[]` clears all.
  - **Per-line** — loop the contract's lines (each line has its own `currentPrice`/base).
  - Emails are **disabled in Appstle**, so the endpoint's "price update email" side effect is moot.
- **Live-validated** on huntb1 (contract `28010479789`): was `currentPrice $47.97 / pricingPolicy null` → after, `basePrice $63.96`, `cycleDiscounts [25% afterCycle 0 → $47.97]`, `currentPrice still $47.97`. Charge preserved, structure added.
- The migration **already fetches the live contract** (`contract-external/{id}`) — reading `pricingPolicy` is **zero extra API cost**.

## Settled decisions

1. **Heal-on-touch only** — no proactive backfill of all null-policy subs. The gateway heals a sub the first time any (non-migration) action runs on it. Untouched subs stay as-is until acted on.
2. **Retry N times, then flag** — a failed monitor check auto-retries a bounded number of times, then surfaces on the monitor for manual review. No auto-rollback.
3. **S&S % source = per-product** — `pricing_rules.subscribe_discount_pct` for the line's product, falling back to `workspaces.subscription_discount_pct` (25). Matches the internal engine, so a healed base == the base the engine derives.

## The linchpin: one inference function

`inferAppstleLineBase(line, catalogMsrpCents, snsPct) → { trueBaseCents, isGrandfathered }`

```
if line.pricingPolicy?.basePrice present:
    trueBase = basePrice                                  // structured — read it directly
else (pricingPolicy === null):
    trueBase = round(currentPrice / (1 − snsPct/100))     // baked/flat — reverse-engineer to preserve charge
isGrandfathered = trueBase < catalogMsrpCents
```

Reading `basePrice` directly (vs always reverse-engineering from `currentPrice`) is strictly more correct: it isolates the true S&S base from any **stacked** discount baked into `currentPrice` (e.g. a "Buy 3 12%"), uses the cycle's **actual** percentage, and cleanly separates standard (`basePrice == catalogMsrp`) from grandfathered.

**Two consumers, same function:**
| Consumer | Action with `trueBase` |
|---|---|
| **Heal** (sub stays on Appstle) | `PUT update-line-item-pricing-policy(basePrice = trueBase, [{afterCycle:0, PERCENTAGE, sns}])` |
| **Migration** (sub → internal) | `price_override_cents = isGrandfathered ? trueBase : (none — use catalog)`; the internal sub is **born healed** |

## Phase 1 — Shared inference + the Appstle gateway ✅

**`src/lib/appstle-pricing.ts`** (new)
- `inferAppstleLineBase(line, catalogMsrpCents, snsPct)` — pure, as above.
- `resolveLineSnsPct(workspaceId, productId)` — per-product `subscribe_discount_pct` → workspace default.
- `healAppstleContract(workspaceId, contractId)` — **idempotent**. GET the contract; for each line where `pricingPolicy === null`, compute `trueBase` + `PUT update-line-item-pricing-policy`. No-op (GET only, no PUT) when every line already has a policy. Returns a summary `{ healedLines, alreadyStructured }`.

**`appstleMutate` gateway** — the single chokepoint (Approach A):
```
appstleMutate(workspaceId, contractId, { skipHeal?: boolean }, fn) →
  if (!skipHeal && !isInternal(contractId)) await healAppstleContract(workspaceId, contractId)
  return fn()
```
Every Appstle **mutation** routes through it. `skipHeal: true` for migration (heal-by-migration) and for billing-only actions that don't need structure (`attemptBilling`).

**Coverage — route these through the gateway** (audited 2026-06-09):
- `src/lib/appstle.ts` wrappers: `appstleSubscriptionAction`, `appstleSkipNextOrder`, `appstleUpdateBillingInterval`, `appstleUpdateNextBillingDate`, `appstleSkipUpcomingOrder`, `appstleUnskipOrder`, `appstleSwitchPaymentMethod`, `appstleAddFreeProduct`, `appstleSwapProduct`. (Skip-heal: `appstleAttemptBilling`, `appstleSendPaymentUpdateEmail`.)
- `src/lib/subscription-items.ts`: `appstleRemoveLineItem`, `subAddItem`, `subRemoveItem`, `subChangeQuantity`, `subUpdateLineItemPrice`, `subSwapVariant` (Appstle branch only — internal branch already returns early).
- `src/lib/appstle-discount.ts`: `applyDiscountWithReplace`.
- **Direct `fetch`es to refactor through the gateway:** `portal/handlers/reactivate.ts` (update-billing-date), `portal/handlers/coupon.ts` (remove-discount), `portal/handlers/replace-variants.ts` (replace-variants-v3), `portal/handlers/address.ts` (update-shipping-address), `lib/action-executor.ts` (update-shipping-address), `app/api/workspaces/[id]/subscriptions/[subId]/coupon/route.ts`, `app/api/journey/[token]/complete/route.ts`, `lib/inngest/dunning.ts`, `lib/inngest/portal-auto-resume.ts`. (NOT the inbound `webhooks/appstle/[workspaceId]` handler — that's Appstle→us.)

> **Hard rule going forward:** no new code calls `subscription-admin.appstle.com` to mutate a contract except through `appstleMutate`. A lint/grep check in review enforces it.

## Phase 2 — Smart migration (heal-by-migration) ✅

Upgrade `appstleLinesToInternalItems` in [[../libraries/migrate-to-internal]] to use `inferAppstleLineBase` on the **already-fetched** live contract instead of only reverse-engineering `currentPrice`:
- `pricingPolicy` present → `trueBase = basePrice`; override only if `< catalogMsrp`.
- `pricingPolicy` null → reverse-engineer; override if `< catalogMsrp`.
- Migration calls Appstle **with `skipHeal: true`** — no point writing a policy to a contract we're about to cancel; the internal sub is born healed.
- **Standardize the Appstle cancel reason to `"migrated to shopcx"`** (today it's "Migrated to internal billing"). `appstleSubscriptionAction(ws, contractId, "cancel", "migrated to shopcx", "ShopCX migration")`.

## Phase 3 — Migration monitor (the checklist) ✅

After a payment method is added + migration runs, write a **verification record** per migrated sub and verify each item; retry-then-flag on failure. North star: **after this passes, the sub will bill on its next renewal.**

**Checklist (per migrated sub):**
1. ✅ `is_internal = true`
2. ✅ `shopify_contract_id` is `internal-*` (no Shopify contract id lingering)
3. ✅ `items[]` reference variant + product **UUIDs** (zero Shopify variant ids)
4. ✅ Appstle contract **actually CANCELLED** — re-fetch + confirm status (don't trust the cancel call alone)
5. ✅ Appstle cancel reason = `"migrated to shopcx"`
6. ✅ Pricing sanity: internal engine charge == pre-migration Appstle charge (±1¢)
7. ✅ Recovery flow: card pinned + immediate charge fired + result fed back to dunning (`last_payment_status` / dunning cycle cleared)
8. ✅ No double-bill risk (Appstle cancelled AND internal active)

**Storage:** a `migration_audits` table (one row per migrated sub: checklist results JSON, status `pending|passed|failed`, retry count, last_error). **Surface:** an internal dashboard view "Migrations — what's stuck?" reading failed/pending rows. **Failure handling:** bounded auto-retry of the failed step, then `status=failed` for manual review. (Decision 2.)

**Immediate-charge → dunning feedback:** a recovery migration typically needs an immediate charge (the prior renewal failed). Fire the internal renewal (`internal-subscription/renewal-attempt`); on success, clear the dunning state so the customer exits the failed-payment funnel.

## Remaining open work

- ⏳ **Phase 1b — consolidate stray direct fetches onto real wrappers.** Phases 1–3 added a `healOnTouch` guard at each of the ~9 direct-`fetch` Appstle sites (functional chokepoint achieved). The cleaner end state: create real wrappers (`appstleUpdateShippingAddress`, `appstleResume`, `appstleRemoveDiscount`, …), delete every direct `fetch`, so there's one literal code path through `appstleMutate`. Deferred because it touches sensitive billing code (dunning, journey-complete, action-executor); the heal guards hold the guarantee until then. **Note:** dunning's strays will be consolidated as part of the **dunning audit** (dunning now migrates subs — it's being reworked separately).

**Shipped after the initial build:**
- ✅ **Standalone integrity sweep** ([[../inngest/migration-integrity-sweep]] — `migration-integrity-sweep-cron`, daily) — seeds a one-off audit for every internal sub never audited and runs the checklist, catching old-logic migrations. First run flagged 5 cancelled subs with Shopify-id items.
- ✅ **Recovery reactivation policy** — auto-reactivating all cancelled subs on recovery was rejected (risks reviving voluntary cancels + duplicates); recovery pins to active/paused subs only, reactivation is per-case during prep ([[customer-portal]] handles the William/Mary cases).

**Resolved:** retry bound `N = 3` (10-min cron, no backoff — recovery charges settle fast); dashboard at `/dashboard/migrations` (owner-only).

## Safety / invariants

- Heal **preserves the customer's charge** — it raises the stored base and adds the offsetting discount; `currentPrice` is unchanged. Never a price hike.
- Heal is **idempotent** — only writes `pricingPolicy: null` lines; converges and stops.
- Migration is **born healed** and never writes to the soon-cancelled Appstle contract.
- Billing never trusts a display/quote value (renewal does its own Braintree charge + Avalara commit).

## Related

[[../libraries/migrate-to-internal]] · [[../libraries/pricing]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/customer-portal]] · [[../integrations/appstle]]
