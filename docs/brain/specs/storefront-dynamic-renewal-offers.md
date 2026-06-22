# Dynamic pricing-rules for persist-to-renewal offers ✅

**Owner:** [[../functions/growth]] · **Parent:** M6 — dynamic pricing-rules for persist-to-renewal offers
**Blocked-by:** [[storefront-optimizer-agent]]

The gated, highest-stakes lever for the [[../goals/storefront-optimizer]] — **offers that persist to renewal**. The autonomy leash (the goal § Autonomy) splits the offer space: a *first-order* offer is a coupon/discount ([[../tables/coupons]], already supported and low-risk); an offer that **persists to renewal** must become a dynamic [[../tables/pricing_rules]] entry — and today `pricing_rules` is effectively **static per product** (one rule joined via `product_pricing_rule`, read live by the renewal/portal pricing engine). This spec makes `pricing_rules` dynamic enough to express a **time-boxed, experiment-scoped persist-to-renewal offer**, and wires it as the [[storefront-optimizer-agent|M4 agent]]'s **approval-gated** offer lever. It is owner-approved because it **bleeds margin on every renewal** (not just the first order), so it is never autonomous. **Contributes-to** CFO (margin) + Retention (renewal pricing). Gated by design: it ships **after** the agent's reversible levers (copy/hero/chapter) are proven, so the offer lever turns on only once the optimizer is trustworthy.

## Phase 1 — dynamic / time-boxed persist-to-renewal offer model ✅
- ✅ shipped
- Added the [[../tables/pricing_rule_offers]] child of [[../tables/pricing_rules]] (the base rule stays static): effective window (`starts_at`/`ends_at`), the persist-to-renewal delta (`subscribe_discount_pct` override OR `renewal_price_cents` fixed price), `(product × lander_type × audience)` + `experiment_id`/`variant_id` scope, and `status` ∈ `proposed｜approved｜active｜expired`. Plus [[../tables/pricing_rule_offer_events]] (audit trail) + [[../tables/subscriptions]]`.pricing_rule_offer_id` (the live binding — a reference, never a baked price). Migration `20260628120000_pricing_rule_offers.sql`; brain pages written.
- `resolveSubscriptionPricing` ([[../libraries/pricing]]) reads the sub's bound offer via [[../libraries/storefront-renewal-offers]] `resolveActiveOffer` and applies it **only while `active` + in-window** — persists to renewal, reverts automatically on deactivation (nothing baked). [[../inngest/internal-subscription-renewals]] + the portal selects now carry the binding column.

## Phase 2 — the approval-gated offer lever in the optimizer ✅
- ✅ shipped
- The [[storefront-optimizer-agent|M4 agent]] emits `propose_offer` (lever `renewal_offer`, seeded into the [[storefront-lever-importance-memory|M2]] taxonomy). `proposeOptimizerOffer` margin-checks + creates the offer `proposed`/inactive; the worker surfaces a `storefront_offer` Approve card — **never auto-activated**. First-order-only discounts stay coupons ([[../tables/coupons]]) on the autonomous path.
- On approval, `materializeOfferCampaign` stands up the M1 experiment (control vs offer arm) bound to the offer + **activates** it; the bandit runs it vs holdout. Offer-arm converters bind at checkout (`bindOfferOnConversion`). The offer's renewal-margin cost flows into realized LTV ([[storefront-ltv-proxy-reconciler|M3]]) so a first-order win that loses on LTV is caught.

## Phase 3 — guardrails, expiry + rollback ✅
- ✅ shipped
- Margin floor (`storefront_optimizer_policy.renewal_margin_floor_pct`, default 0.35): `evaluateOfferMargin` blocks any offer below it; the worker **escalates to Growth + CFO** (a `margin_blocked` audit row) instead of surfacing it as a normal proposal.
- Auto-expire at `ends_at` (`expireDueOffers`) + on M1 rollback/kill (`deactivateOffersForExperiment`, wired into [[storefront-experiment-refresh]]) — affected subs revert to base renewal pricing on their next renewal, with a [[../tables/pricing_rule_offer_events]] audit row (a renewal-touching offer is cleanly un-touchable).

## Safety / invariants
- **Never autonomous.** A persist-to-renewal offer is ALWAYS owner-approved before activation (it bleeds margin on every renewal). The agent proposes; the owner disposes. First-order coupons stay on the autonomous path; persist-to-renewal offers do not.
- **Margin-floor hard rail.** No offer below the modeled renewal-margin floor; breaching escalates to Growth + CFO ([[../operational-rules]] § North star).
- **Scoped + time-boxed.** Every offer carries an explicit window + scope; it auto-expires and never silently becomes the permanent default price.
- **Reversible on real renewals.** Rollback/expiry reverts affected subscriptions to base pricing with an audit trail — a renewal offer that touched live subs must be cleanly un-touchable.
- **LTV-accounted.** The offer's renewal-margin cost flows into the M3 predicted-LTV proxy, so a first-order win that churns is caught by the reconciler, not rewarded.
- **Compliance.** No misrepresented pricing; honest offer labeling (brand voice + supplement compliance, the goal § hard rails).

## Completion criteria
- `pricing_rules` (or a child table) expresses a scoped, time-boxed, persist-to-renewal offer with `status`, and `resolveSubscriptionPricing` honors the active offer at renewal.
- The M4 agent can propose an `offer`-type variant that is created inactive and requires owner approval before activation (first-order coupons stay autonomous).
- An approved offer runs as an M1 arm vs holdout, attributed on the M3 LTV proxy (renewal-margin cost included).
- A margin-floor breach is blocked/escalated; an offer auto-expires at `ends_at`.
- Rollback/expiry reverts affected subscriptions to base renewal pricing with an audit trail.

## Verification
- Apply `npx tsx scripts/apply-pricing-rule-offers-migration.ts` → expect `>>> APPLY RESULT: OK — pricing_rule_offers (… cols) + pricing_rule_offer_events created · subscriptions.pricing_rule_offer_id ✓ · storefront_optimizer_policy.renewal_margin_floor_pct ✓ · renewal_offer lever seeded=true`. Confirm in Supabase the `status` CHECK (`proposed｜approved｜active｜expired`) and the `pricing_rule_offers_value_present` / `_window` CHECKs.
- Feed the box session a hypothesis whose best lever is a persist-to-renewal price change on an Amazing Coffee arm → expect `status='propose_offer'`, then `select status, pending_actions->0->>'type' from agent_jobs where kind='storefront-optimizer' order by created_at desc limit 1;` → `status='needs_approval'` + a `storefront_offer` card; `select status from pricing_rule_offers order by created_at desc limit 1;` → `proposed` (NOT active). It does NOT activate autonomously.
- Approve the card (`/api/roadmap/approve` → `queued_resume`) → expect the worker to (a) `update pricing_rule_offers set status='active'` and (b) stand up a `storefront_experiments` row (lever=`renewal_offer`, status `running`) with a control + offer arm linked via `pricing_rule_offers.experiment_id/variant_id`. Verify a `pricing_rule_offer_events` `activated` row.
- Bind a sub to the active offer (a checkout on the offer arm, or `update subscriptions set pricing_rule_offer_id='<offer>'`) → run `resolveSubscriptionPricing` (or trigger a renewal) → expect the offer applied **at renewal** (a `Renewal Offer` pill, `is_offer=true` on the line, the overridden unit price) for the in-scope product, and base pricing for a sub with no binding / out-of-scope product.
- Propose an offer below the floor (e.g. a 70% renewal S&S, modeled margin < `renewal_margin_floor_pct`) → expect `agent_jobs.status='needs_attention'` with `error` "escalated to Growth + CFO", a `pricing_rule_offers` row `margin_floor_ok=false` + a `margin_blocked` audit row, and **no** approval card.
- Push an active offer past `ends_at` (or drive its experiment to an M1 LTV-proxy/refund-spike rollback) and run the storefront experiments refresh → expect `pricing_rule_offers.status='expired'` with `deactivation_reason` set + a `pricing_rule_offer_events` `expired`/`rolled_back` row; the bound sub's next `resolveSubscriptionPricing` reverts to base pricing (no `is_offer`).
- Confirm a first-order-only discount still uses the autonomous coupon path ([[../tables/coupons]]) — it never creates a `pricing_rule_offers` row or hits the `storefront_offer` gate.
