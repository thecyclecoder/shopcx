# Commerce SDK

One internal-aware layer for every customer-facing commerce **read and write**. Before this, three stacks — the dashboard, the two customer portals, and the AI/agent stack — each queried commerce entities (subscriptions, orders, returns, replacements, customers, loyalty, chargebacks, fraud, crisis) their own way: mutations were ~70% converged (AI/Improve/Triage shared `directActionHandlers`; portal + AI dispatched through the `appstle.ts` / [[../libraries/subscription-items]] wrappers) but **reads were not unified at all**, and pricing-enrichment (the `$NaN` guard) was applied inconsistently. Two one-off money bugs — a next-order date set via raw Shopify GraphQL instead of the internal-aware dispatcher, and a phantom refund — turned out to be one systemic gap: surfaces reaching past the internal-vs-Appstle branch and past the money resolver. The fix is `src/lib/commerce/*` — entity-named, internal-vs-Appstle-aware, gateway-aware, pricing-resolved — that every surface becomes a thin consumer of.

This page traces how a commerce read/write flows through the SDK and records the goal that built it. Owner: [[../functions/platform]].

## Cast

- **SDK modules:** `src/lib/commerce/*.ts` — one per entity: [[../libraries/commerce__subscription]], [[../libraries/commerce__order]], [[../libraries/commerce__return]], [[../libraries/commerce__refund]], [[../libraries/commerce__replacement]], [[../libraries/commerce__customer]], [[../libraries/commerce__loyalty]], [[../libraries/commerce__chargeback]], [[../libraries/commerce__crisis]], [[../libraries/commerce__fraud]].
- **Money resolver:** `priceSubscription` in [[../libraries/pricing]] — the single path to any line/total price.
- **Branch targets:** [[../libraries/internal-subscription]] (internal Braintree flow) and [[../integrations/appstle]] (Appstle API + `healOnTouch`), plus [[../libraries/subscription-items]] for line-item mutations.
- **Consumers:** the dashboard ([[ticket-lifecycle]], [[../dashboard/customers]], [[../dashboard/loyalty]]), the AI/agent stack ([[../libraries/action-executor]] `directActionHandlers`), and the [[customer-portal]] (2 render surfaces).
- **Full surface map:** `docs/brain/reference/commerce-sdk-inventory.html` — the nav-driven Display + Mutation operation set, canonical view shapes, the `appstleX → subscriptionX` rename map, and the 9-item defect register (open the self-contained HTML locally).

## Invariants the SDK guarantees

- **One money resolver.** `priceSubscription` ([[../libraries/pricing]]) is the only path to a line/total price; internal subs can never emit `undefined` cents, so no surface can render `$NaN`/`$0`. Calling `priceSubscription` directly outside the SDK is a bypass — non-portal surfaces read pre-priced `SubscriptionView`/`OrderView` shapes instead.
- **Every mutation dispatches internal-vs-Appstle** at the top (`isInternalSubscription()`), and for money is gateway-aware (Braintree vs Shopify). Callers never decide which billing path to call — they call the `subscriptionX`/entity function and the SDK branches.
- **SQL/RPC for anything list-or-aggregate** — list ops are backed by Postgres RPC that projects sub + latest order + upcoming order in one round trip (a prior session cut a 3h job to 8s this way).
- **No silent truncation** — list ops paginate past the 1000-row cap by cursor on `updated_at + id`.

## Read path

A surface calls an entity Display op — `getSubscription(workspaceId, subId)`, `listSubscriptions(workspaceId, filters?)`, `getOrder`, `listOrders`, etc. — and receives a fully enriched view (`SubscriptionView`, `OrderView`, …): priced lines, MSRP/discount/tax, coupon, payment, dunning. Every money field resolves through `priceSubscription`, which runs the pricing engine for internal subs and uses baked Appstle prices for Appstle subs. The dashboard, ticket detail, AI paths, and the internal APIs all consume these views — no surface queries the DB directly for a commerce entity anymore, and none touches raw `items[].price_cents`. The portal keeps its own display wrappers (`enrichContractPricing`, `page.tsx` server render) but prices through the same engine (see [[../libraries/pricing]] § Display layer).

## Write path

A surface calls an entity Mutation op — `subscriptionAction` (pause/cancel/resume), `subscriptionSkipNextOrder`, `subscriptionUpdateNextBillingDate`, `subscriptionAddItem`/`RemoveItem`/`ChangeQuantity`/`SwapVariant`, `subscriptionOrderNow`, and the refund/return/replacement/loyalty/coupon ops on their modules. Each branches on the actual sub type: internal → `internal*` handlers ([[../libraries/internal-subscription]]); Appstle → `appstleX` wrappers ([[../integrations/appstle]]) top-guarded by `healOnTouch`. The old `appstleX` exports survive as `@deprecated` shims that delegate here, so callers migrate incrementally. `subscriptionOrderNow` is the flavor-aware single entry point for on-demand billing — it fixes the bug where an internal sub's "Order Now" reported success while never billing (the `appstleAttemptBilling` `internal-*` guard is a NO-OP success).

## The goal — how it was built (5 milestones)

Sequenced build plan: stop the money bleeding → SDK core with zero consumers → battle-test in isolation → migrate internal surfaces → migrate the customer portal LAST.

- **M1 — Stop the bleeding (the two critical money bugs).** Wired `partialRefundByAmount`/`refundBraintreeTransaction` into the returns refund flow (phantom-refund bug), and routed `subscriptions/[subId]/coupon` (POST + DELETE) + the AI `apply_coupon`/`remove_coupon` handlers through the internal-aware dispatcher (coupon mis-fire). → folded into [[return-pipeline]], [[../libraries/commerce__refund]], [[../libraries/marketing-coupons]].
- **M2 — SDK core: Display + Mutation, zero consumers.** Scaffolded `src/lib/commerce`, centralized `priceSubscription`, enumerated the Display + Mutation operation sets, and renamed every `appstleX` → `subscriptionX`. Shipped with no surface changes. → folded into [[../libraries/pricing]] + the `commerce__*` module pages.
- **M3 — Battle-test harness + performance.** A differential harness runs locally against read-only prod data, proving zero `$NaN`/`$0` across internal + Appstle + grandfathered samples and parity with today's correct outputs. → the harness lives in `scripts/` (see the inventory reference).
- **M4 — Migrate internal surfaces (dashboard + agent + AI).** Ticket detail — the highest-value single target (union of every read + mutation, all raw fetch, none internal-aware before) — plus the remaining dashboard/agent/AI stack, plus loyalty program-wide stats + a negative-balance guard on manual adjust. → folded into [[ticket-lifecycle]], [[../libraries/commerce__loyalty]], [[../dashboard/loyalty]].
- **M5 — Migrate the customer portal (LAST, diff-verified).** The final domino — see Status below.

## Status / open work

**Shipped + folded:** M1–M4. Every child spec landed clean and folded into its permanent home:

| Milestone | Spec (folded) | Permanent home |
|---|---|---|
| M1 | returns-refund-internal-aware-dispatcher | [[return-pipeline]] · [[../libraries/commerce__refund]] |
| M1 | subscription-coupon-internal-aware-dispatcher | [[../libraries/marketing-coupons]] · [[../libraries/commerce__subscription]] |
| M2 | commerce-sdk-scaffold-money-resolver | [[../libraries/pricing]] |
| M2 | commerce-sdk-display-operations | `commerce__*` module pages |
| M2 | commerce-sdk-mutations-rename-subscription-prefix | [[../libraries/commerce__subscription]] (rename map) |
| M3 | commerce-sdk-differential-harness | `scripts/` (see inventory reference) |
| M4 | commerce-sdk-migrate-ticket-detail | [[ticket-lifecycle]] |
| M4 | commerce-sdk-migrate-dashboard-agent-ai | [[../libraries/action-executor]] · [[../dashboard/customers]] |
| M4 | loyalty-list-stats-and-adjust-guard | [[../libraries/commerce__loyalty]] · [[../dashboard/loyalty]] |

**Known gaps / not yet shipped:**
- **M5 — customer-portal migration is the final open domino** (`commerce-sdk-migrate-customer-portal`, planned). The portal still paints from its own display wrappers (`enrichContractPricing` + the mini-site `page.tsx` server render) rather than consuming the SDK's `SubscriptionView` directly. Both portal paths already price through the same `priceSubscription` engine (so no `$NaN` risk), but the read shape is not yet the unified view. This migration is intentionally last and must be diff-verified against today's correct portal output before it lands. Until then, the portal is the one customer-facing surface not yet a thin SDK consumer.
- The old `appstleX` exports remain as `@deprecated` shims; the final caller sweep retires them once M5 lands.

**Open questions:** None.

## Related

[[subscription-billing]] · [[customer-portal]] · [[ticket-lifecycle]] · [[return-pipeline]] · [[chargeback-pipeline]] · [[../libraries/pricing]] · [[../libraries/commerce__subscription]] · [[../libraries/commerce__order]] · [[../libraries/commerce__return]] · [[../libraries/commerce__refund]] · [[../libraries/commerce__replacement]] · [[../libraries/commerce__customer]] · [[../libraries/commerce__loyalty]] · [[../libraries/commerce__chargeback]] · [[../libraries/commerce__crisis]] · [[../libraries/commerce__fraud]] · [[../libraries/internal-subscription]] · [[../libraries/subscription-items]] · [[../libraries/action-executor]] · [[../integrations/appstle]] · [[../reference/commerce-sdk-inventory.html]] · [[../functions/platform]]
