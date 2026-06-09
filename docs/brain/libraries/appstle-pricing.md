# appstle-pricing.ts

`src/lib/appstle-pricing.ts` — the Appstle pricing **heal** + the single mutation **gateway**. Fixes the `pricingPolicy: null` subs Appstle's original migration left behind (flat baked price, no structured S&S discount), which break on legacy-portal modification and are a double-discount landmine for our [[pricing]] engine.

See [[../specs/appstle-pricing-heal-and-migration-monitor]] for the full design.

## Exports

- **`inferAppstleLineBase(line, catalogMsrpCents, snsPct) → { trueBaseCents, isGrandfathered, source }`** — the ONE pricing-inference function, shared by the heal AND the migration ([[migrate-to-internal]]):
  - `pricingPolicy.basePrice` present → `trueBase = basePrice` (`source: pricing_policy`). Isolates the true S&S base from any stacked discount in `currentPrice`.
  - `pricingPolicy === null` → `trueBase = round(currentPrice / (1 − sns))` (`source: reverse_engineered`) — preserves the charge.
  - `isGrandfathered = trueBase < catalogMsrp`.
- **`resolveLineSnsPct(admin, workspaceId, productId)`** — per-product `subscribe_discount_pct` → workspace default (matches the internal engine).
- **`healAppstleContract(workspaceId, contractId) → HealResult`** — **idempotent**. GETs the contract; for each `pricingPolicy === null` line, computes `trueBase` and `PUT`s `update-line-item-pricing-policy(basePrice, [{afterCycle:0, PERCENTAGE, sns}])`. No-op (GET only) once every line is structured. Preserves the customer's charge; no price hike. (Appstle emails are disabled, so the endpoint's price-update email is moot.)
- **`healOnTouch(workspaceId, contractId)`** — the gateway's heal step as one line (non-fatal try/catch). Dropped at the top of every Appstle mutation's Appstle branch.
- **`appstleMutate(workspaceId, contractId, { skipHeal }, fn)`** — closure form of the chokepoint for call sites that aren't tidy wrappers; heals then runs `fn`. `skipHeal: true` for migration + billing-only actions.

## Heal-on-touch coverage

Every Appstle **mutation** path heals first (so no modification lands on an unstructured sub, and touches converge the legacy-portal fix). Wired into: the [[appstle]] wrappers, [[subscription-items]] `sub*` mutations, the portal handlers (replace-variants/coupon/address/reactivate/loyalty-apply), and the stray direct fetches (action-executor, dunning, portal-auto-resume, the coupon API route, journey-complete). **Cancel skips heal** (the sub is being killed). **Migration skips heal** — it's "heal-by-migration" (the internal sub is born healed from `inferAppstleLineBase`).

> **Hard rule:** no new code calls `subscription-admin.appstle.com` to mutate a contract without a `healOnTouch`/`appstleMutate` guard. (Phase 1b will consolidate the strays onto real wrappers — see the spec.)

## The endpoint

`PUT /api/external/v2/subscription-contracts-update-line-item-pricing-policy?contractId=&lineId=&basePrice=` · header `X-API-Key` · body = cycles array (max 2) `[{afterCycle:0, discountType:"PERCENTAGE", value:25}]`. **Per-line** (`lineId` required — no all-lines variant). Validated live on huntb1: `$47.97 flat / null` → `basePrice $63.96 + 25% cycle → $47.97` (charge preserved, structure added).

---

[[../README]] · [[migrate-to-internal]] · [[pricing]] · [[../integrations/appstle]]
