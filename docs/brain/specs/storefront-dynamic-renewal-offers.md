# Dynamic pricing-rules for persist-to-renewal offers

**Owner:** [[../functions/growth]] · **Parent:** M6 — dynamic pricing-rules for persist-to-renewal offers
**Blocked-by:** [[storefront-optimizer-agent]]

The gated, highest-stakes lever for the [[../goals/storefront-optimizer]] — **offers that persist to renewal**. The autonomy leash (the goal § Autonomy) splits the offer space: a *first-order* offer is a coupon/discount ([[../tables/coupons]], already supported and low-risk); an offer that **persists to renewal** must become a dynamic [[../tables/pricing_rules]] entry — and today `pricing_rules` is effectively **static per product** (one rule joined via `product_pricing_rule`, read live by the renewal/portal pricing engine). This spec makes `pricing_rules` dynamic enough to express a **time-boxed, experiment-scoped persist-to-renewal offer**, and wires it as the [[storefront-optimizer-agent|M4 agent]]'s **approval-gated** offer lever. It is owner-approved because it **bleeds margin on every renewal** (not just the first order), so it is never autonomous. **Contributes-to** CFO (margin) + Retention (renewal pricing). Gated by design: it ships **after** the agent's reversible levers (copy/hero/chapter) are proven, so the offer lever turns on only once the optimizer is trustworthy.

## Phase 1 — dynamic / time-boxed persist-to-renewal offer model
- ✅ shipped (2026-06-24)
- ✅ Added the `pricing_rule_offers` **child** table (migration `20260624000000_pricing_rule_offers.sql`) expressing a **scoped, time-boxed renewal offer**: window (`starts_at`/`ends_at`, CHECK `ends_at > starts_at`), the persist-to-renewal delta (`subscribe_discount_pct` override **or** `renewal_price_cents` fixed price — discriminated by `offer_type`, CHECK `value_present`), the `(product × lander_type × audience)` / `experiment_id` + `variant_id` scope, and `status` ∈ `proposed｜approved｜active｜expired` (CHECK). Brain pages: new [[../tables/pricing_rule_offers]], updated [[../tables/pricing_rules]] + [[../tables/subscriptions]] + [[../libraries/pricing]].
  - **Reconcile note (2026-06-24):** the live table was first created out-of-band by closed PR #281 carrying the **full guardrail shape** (`offer_type`, `margin_floor_pct`, `modeled_renewal_margin_pct`, `cogs_source_missing`, lifecycle timestamps). The migration here was rewritten to `CREATE … IF NOT EXISTS` that exact rich schema (no-op on prod, correct on a fresh DB) + add the genuinely-missing `subscriptions.pricing_offer_id`; `resolveSubscriptionPricing` reads the live columns (no `label`). Those guardrail columns are populated by the deferred [[storefront-renewal-offer-lever]].
- ✅ Added [[../tables/subscriptions]]`.pricing_offer_id` (→ `pricing_rule_offers`, `ON DELETE SET NULL`) — the **reference, not baked price** a sub carries to its acquisition offer, so the offer persists to renewal and stays reversible.
- ✅ `resolveSubscriptionPricing` ([[../libraries/pricing]]) now reads that reference and applies the offer's delta to in-scope product lines **only when** `status='active'` and `now() ∈ [starts_at, ends_at]` — so the offer persists to renewal (not just first order), and an expired/un-approved offer reverts to base pricing with no row mutation. (Probed the live pricing path first — callers pass full sub rows; what-if quote callers pass synthetic objects without an offer id, so they're unaffected.)

> **Note (build, 2026-06-24):** this ships the offer *model* + the renewal read only. Nothing **populates** `pricing_offer_id` yet — that (the activation lever, owner-approval gate, margin-floor / expiry / rollback guardrails) is [[storefront-renewal-offer-lever]] (deferred). So the read path is correct but **dormant** until that card builds.

## Phases 2 + 3 — the offer lever + its guardrails → **split to [[storefront-renewal-offer-lever]] (deferred, 2026-06-23)**
The offer-*activation* lever (former P2) **and its guardrails/expiry/rollback** (former P3) were **deferred to their own card** — they're the margin-bleeding part that "turns on only once the optimizer's reversible levers are proven," so they shouldn't build alongside the foundation. A box build (PR #281, closed) built them prematurely; moved to [[storefront-renewal-offer-lever]] (⏳ deferred, `Blocked-by` this spec) so they're tracked, not lost, and not re-built until wanted. **This spec now ships only the offer *model* (P1)** — the dynamic, time-boxed `pricing_rule_offers` schema + the renewal pricing read; the lever + its guardrails activate separately.

## Safety / invariants
- **Never autonomous.** A persist-to-renewal offer is ALWAYS owner-approved before activation (it bleeds margin on every renewal). The agent proposes; the owner disposes. First-order coupons stay on the autonomous path; persist-to-renewal offers do not.
- **Margin-floor hard rail.** No offer below the modeled renewal-margin floor; breaching escalates to Growth + CFO ([[../operational-rules]] § North star).
- **Scoped + time-boxed.** Every offer carries an explicit window + scope; it auto-expires and never silently becomes the permanent default price.
- **Reversible on real renewals.** Rollback/expiry reverts affected subscriptions to base pricing with an audit trail — a renewal offer that touched live subs must be cleanly un-touchable.
- **LTV-accounted.** The offer's renewal-margin cost flows into the M3 predicted-LTV proxy, so a first-order win that churns is caught by the reconciler, not rewarded.
- **Compliance.** No misrepresented pricing; honest offer labeling (brand voice + supplement compliance, the goal § hard rails).

## Completion criteria (this spec = the offer *model* only — P1)
- `pricing_rules` (or a child table) expresses a scoped, time-boxed, persist-to-renewal offer with `status`, and `resolveSubscriptionPricing` honors the active offer at renewal.
- *(The offer lever + its margin-floor/expiry/rollback guardrails are [[storefront-renewal-offer-lever]], deferred.)*

## Verification
- Apply the migration → expect the new offer columns/table present (`✓ … starts_at/ends_at/status …`); confirm the `status` CHECK and the scope columns in Supabase.
- With an `active` offer row scoped to an Amazing Coffee experiment arm, place a subscription order on that arm → confirm `resolveSubscriptionPricing` applies the offer **at renewal** (not just first order) for an in-scope sub, and base pricing for an out-of-scope sub.
- Confirm a first-order-only discount still uses the autonomous coupon path ([[../tables/coupons]]) and does NOT hit this gate.
- *(Lever + guardrail verification — proposing/approving an offer, margin-floor block, auto-expire, rollback — moves to [[storefront-renewal-offer-lever]].)*
