# storefront-renewal-offers.ts — persist-to-renewal offer lifecycle (M6)

`src/lib/storefront/renewal-offers.ts` · owns the [[../tables/pricing_rule_offers]] lifecycle: the margin-floor rail, propose → activate → expire/deactivate, the engine read, and the checkout binding. The gated, highest-stakes optimizer lever ([[../specs/storefront-dynamic-renewal-offers]]) — an offer that persists to **every renewal**, always owner-approved.

## Exports

```ts
modelRenewalMargin(opts): MarginModel           // model the offer's renewal margin (flagged placeholder COGS)
evaluateOfferMargin(opts): MarginVerdict         // is it ≥ the configured floor?
proposeOffer(opts): ProposeOfferResult           // create `proposed`/inactive after the margin check
activateOffer(opts): { ok, detail }              // owner approval → `active` (persists to renewal)
deactivateOffer(opts) / deactivateOffersForExperiment(opts) / expireDueOffers(opts)  // Phase 3 expiry/rollback
resolveActiveOffer(opts): RenewalOffer | null    // the engine's read — active + in-window only
bindOfferOnConversion(opts): { bound, offer_id } // checkout binding (offer-arm converters)
logOfferEvent(admin, opts)                       // append a [[../tables/pricing_rule_offer_events]] audit row
loadProductPricingBasis(admin, ws, productId)    // base MSRP + S&S for the margin model
```

## The margin-floor rail (Phase 3)

`evaluateOfferMargin` models renewal margin with the **same flagged placeholder economics as M3** ([[storefront-ltv-proxy]] `PLACEHOLDER_MARGIN_FRACTION`) — there is no per-product COGS source, so unit COGS ≈ `catalog MSRP × (1 − placeholder)`. The deeper the discount, the lower the modeled margin. A breach (`modeled_margin_pct < floor`) is **blocked** — `proposeOffer` records the offer `proposed` + writes a `margin_blocked` audit row, and the worker **escalates to Growth + CFO** instead of surfacing it. The floor is `storefront_optimizer_policy.renewal_margin_floor_pct` (default 0.35).

## Reversible on real renewals

[[pricing]]'s `resolveSubscriptionPricing` applies an offer **only when `resolveActiveOffer` returns a row** (status `active` + within window) for the sub's bound `pricing_rule_offer_id`. So expiry/rollback just flips `status='expired'` and every bound sub reverts to base renewal pricing on its next renewal — **nothing baked to un-bake**. `expireDueOffers` (auto at `ends_at`) and `deactivateOffersForExperiment` (M1 rollback/kill, wired in [[storefront-experiment-refresh]]) both audit the deactivation.

## Callers

- [[storefront-optimizer-agent]] — `proposeOptimizerOffer` (margin-checked propose) + `materializeOfferCampaign` (on approval: stand up the M1 offer arm vs holdout, link the offer, activate it).
- `scripts/builder-worker.ts` `runStorefrontOptimizerJob` — surfaces the `storefront_offer` Approve card; escalates a margin breach.
- [[pricing]] — `resolveActiveOffer` at renewal/portal pricing time.
- `src/app/api/checkout/route.ts` — `bindOfferOnConversion` after an internal sub is created.
- [[storefront-experiment-refresh]] — `expireDueOffers` + `deactivateOffersForExperiment` on rollback/kill.

## Gotchas

- Offers are scoped to `(product × lander_type × audience)` / an experiment arm. `bindOfferOnConversion` binds a sub **only if the converting identity was exposed to the offer arm (non-holdout)** — holdout converters get base pricing, preserving clean attribution.

---

[[../README]] · [[../tables/pricing_rule_offers]] · [[pricing]] · [[../specs/storefront-dynamic-renewal-offers]]
