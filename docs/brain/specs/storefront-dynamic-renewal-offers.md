# Dynamic pricing-rules for persist-to-renewal offers ⏳

**Owner:** [[../functions/growth]] · **Parent:** M6 — dynamic pricing-rules for persist-to-renewal offers
**Blocked-by:** [[storefront-optimizer-agent]]

The gated, highest-stakes lever for the [[../goals/storefront-optimizer]] — **offers that persist to renewal**. The autonomy leash (the goal § Autonomy) splits the offer space: a *first-order* offer is a coupon/discount ([[../tables/coupons]], already supported and low-risk); an offer that **persists to renewal** must become a dynamic [[../tables/pricing_rules]] entry — and today `pricing_rules` is effectively **static per product** (one rule joined via `product_pricing_rule`, read live by the renewal/portal pricing engine). This spec makes `pricing_rules` dynamic enough to express a **time-boxed, experiment-scoped persist-to-renewal offer**, and wires it as the [[storefront-optimizer-agent|M4 agent]]'s **approval-gated** offer lever. It is owner-approved because it **bleeds margin on every renewal** (not just the first order), so it is never autonomous. **Contributes-to** CFO (margin) + Retention (renewal pricing). Gated by design: it ships **after** the agent's reversible levers (copy/hero/chapter) are proven, so the offer lever turns on only once the optimizer is trustworthy.

## Phase 1 — dynamic / time-boxed persist-to-renewal offer model ⏳
- ⏳ planned
- Extend [[../tables/pricing_rules]] (or add a `pricing_rule_offers` child) to express a **scoped, time-boxed renewal offer**: an effective window (`starts_at`/`ends_at`), the persist-to-renewal price delta (an additional `subscribe_discount_pct` override or a fixed renewal price), the `(product × lander-type × audience)` / experiment scope it applies to, and `status` ∈ `proposed｜approved｜active｜expired`. Migration + update [[write-brain-page]] `tables/pricing_rules.md` (it currently documents no offer/time-boxing construct).
- Ensure `resolveSubscriptionPricing` (the renewal + portal pricing engine, [[../libraries/pricing]]) reads the active scoped offer correctly at renewal time — the offer persists to renewal, not just first order; **probe the live pricing path before assuming its shape** (CLAUDE.md "database is the spec").

## Phase 2 — the approval-gated offer lever → **split to [[storefront-renewal-offer-lever]] (deferred, 2026-06-23)**
The offer-*activation* lever was **deferred to its own card** — it's the margin-bleeding part that "turns on only once the optimizer's reversible levers are proven," so it shouldn't build alongside the foundation. A box build (PR #281, closed) built it prematurely; moved to [[storefront-renewal-offer-lever]] (⏳ deferred, `Blocked-by` this spec) so it's tracked, not lost, and not re-built until wanted. This spec now ships the **offer model (P1)** + its **guardrails (P3)**; the lever activates separately.

## Phase 3 — guardrails, expiry + rollback ⏳
- ⏳ planned
- *(Gated on [[storefront-renewal-offer-lever]] for live use — the floor/expiry/rollback guard the deferred offer lever; build the model + this guardrail scaffolding now, but a real activated offer only exists once the lever ships.)*
- A margin floor: the agent may never *propose* (and the owner is warned before approving) an offer whose modeled renewal margin drops below a configured floor; breaching escalates to the [[../functions/growth|Growth director]] + CFO, it is not surfaced as a normal proposal.
- Auto-expire at `ends_at`; on an LTV-proxy or refund-spike regression (M1 auto-rollback), **deactivate the offer** and revert affected subscriptions' renewal pricing to the base `pricing_rules` — with a clear audit trail (a persist-to-renewal offer touched real renewals, so rollback must un-touch them).

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
- Apply the migration → expect the new offer columns/table present (`✓ … starts_at/ends_at/status …`); confirm the `status` CHECK and the scope columns in Supabase.
- Create a `proposed` persist-to-renewal offer scoped to an Amazing Coffee experiment arm → confirm it is **inactive** and surfaces as an M4 owner-approval `pending_actions` card; it does NOT activate autonomously.
- Approve it → expect `status='active'`; place a subscription order on that arm and confirm `resolveSubscriptionPricing` applies the offer **at renewal** (not just first order) for an in-scope sub, and base pricing for an out-of-scope sub.
- Propose an offer below the modeled margin floor → expect it blocked/escalated to Growth + CFO, not surfaced as a normal approvable proposal.
- Let an offer pass `ends_at` (or trigger an M1 LTV-proxy regression rollback) → expect `status='expired'`/deactivated and affected subscriptions reverted to base renewal pricing with an audit row.
- Confirm a first-order-only discount still uses the autonomous coupon path ([[../tables/coupons]]) and does NOT hit this gate.
