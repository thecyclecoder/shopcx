# appstle-pricing.ts

`src/lib/appstle-pricing.ts` — the Appstle pricing **heal** + the single mutation **gateway**. Fixes the `pricingPolicy: null` subs Appstle's original migration left behind (flat baked price, no structured S&S discount), which break on legacy-portal modification and are a double-discount landmine for our [[pricing]] engine.

Full flow: [[../lifecycles/subscription-billing]] § Migration path (verified + archived — see [[../archive]]).

## Exports

- **`inferAppstleLineBase(line, catalogMsrpCents, snsPct) → { trueBaseCents, isGrandfathered, source }`** — the ONE pricing-inference function, shared by the heal AND the migration ([[migrate-to-internal]]):
  - `pricingPolicy.basePrice` present → `trueBase = basePrice` (`source: pricing_policy`). Isolates the true S&S base from any stacked discount in `currentPrice`.
  - `pricingPolicy === null` → `trueBase = round(currentPrice / (1 − sns))` (`source: reverse_engineered`) — preserves the charge.
  - `isGrandfathered = trueBase < catalogMsrp`.
- **`resolveLineSnsPct(admin, workspaceId, productId)`** — per-product `subscribe_discount_pct` → workspace default (matches the internal engine).
- **`healAppstleContract(workspaceId, contractId) → HealResult`** — **idempotent**. GETs the contract; for each `pricingPolicy === null` line, computes `trueBase` and `PUT`s `update-line-item-pricing-policy(basePrice, [{afterCycle:0, PERCENTAGE, sns}])`. No-op (GET only) once every line is structured. Preserves the customer's charge; no price hike. (Appstle emails are disabled, so the endpoint's price-update email is moot.) A per-line PUT failure is **`console.warn` (not `error`)** — the failure is tracked non-fatally on `HealResult.failed`, and the heal is best-effort; the warn line includes the response body snippet (~200 chars) so the next occurrence is diagnosable in one look. Mirrors the precedent for [[subscription-items]] `appstleRemoveLineItem`'s last-item guardrail (warn, not error) — keeps the Control Tower ERR feed clean while preserving the diagnostic.
- **`healOnTouch(workspaceId, contractId)`** — the gateway's heal step as one line (non-fatal try/catch). Dropped at the top of every Appstle mutation's Appstle branch.
- **`appstleMutate(workspaceId, contractId, { skipHeal }, fn)`** — closure form of the chokepoint for call sites that aren't tidy wrappers; heals then runs `fn`. `skipHeal: true` for migration + billing-only actions.

## Heal-on-touch coverage

Every Appstle **mutation** path heals first (so no modification lands on an unstructured sub, and touches converge the legacy-portal fix). Wired into: the [[appstle]] wrappers, [[subscription-items]] `sub*` mutations, the portal handlers (replace-variants/coupon/address/reactivate/loyalty-apply), and the stray direct fetches (action-executor, dunning, portal-auto-resume, the coupon API route, journey-complete). **Cancel skips heal** (the sub is being killed). **Migration skips heal** — it's "heal-by-migration" (the internal sub is born healed from `inferAppstleLineBase`).

> **Hard rule:** no new code calls `subscription-admin.appstle.com` to mutate a contract without a `healOnTouch`/`appstleMutate` guard. (Phase 1b will consolidate the strays onto real wrappers — see the spec.)

## The endpoint

`PUT /api/external/v2/subscription-contracts-update-line-item-pricing-policy?contractId=&lineId=&basePrice=` · header `X-API-Key` · body = cycles array (max 2) `[{afterCycle:0, discountType:"PERCENTAGE", value:25}]`. **Per-line** (`lineId` required — no all-lines variant). Validated live on huntb1: `$47.97 flat / null` → `basePrice $63.96 + 25% cycle → $47.97` (charge preserved, structure added).

## Overcharge remediation

`resolveLineSnsPct` is reused by [[subscription-overcharge]] to compute the `restore_base_cents` for an overcharged line (`base = expected / (1 − sns)`), and the heal is the "fix the sub going forward" half of the remediation playbook: `subUpdateLineItemPrice → healOnTouch` restores the grandfathered base on Appstle in place. **The remediation NEVER migrates to internal** — a pricing error is healed on Appstle (migration needs a saved Braintree PM and solves a different problem). See [[subscription-overcharge]].

---

[[../README]] · [[migrate-to-internal]] · [[pricing]] · [[subscription-overcharge]] · [[../integrations/appstle]]
