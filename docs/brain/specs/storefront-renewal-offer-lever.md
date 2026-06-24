# Persist-to-renewal offer lever (storefront optimizer) ⏳

**Deferred:** split from [[storefront-dynamic-renewal-offers]] (2026-06-23) — **not needed now.** This is the gated, **margin-bleeding** offer-*activation* lever **+ its guardrails** (former parent P2 + P3) — by design they "turn on only once the optimizer's reversible levers (copy/hero/chapter) are proven trustworthy" (the [[../goals/storefront-optimizer]] § Autonomy). A box build (PR #281, closed) built them prematurely; pulled out here so they're **tracked, not lost, and not re-built** until the optimizer has earned the offer envelope. Only the offer *model* ([[storefront-dynamic-renewal-offers]] P1 — the `pricing_rule_offers` schema + renewal read) ships first.

**Owner:** [[../functions/growth]] · **Parent:** M6 — dynamic pricing-rules for persist-to-renewal offers
**Blocked-by:** [[storefront-dynamic-renewal-offers]]

The **approval-gated persist-to-renewal offer lever** for the [[storefront-optimizer-agent|M4 agent]] — the highest-stakes lever in the offer space. A *first-order* offer stays a coupon ([[../tables/coupons]], low-risk, autonomous); an offer that **persists to renewal** must become a dynamic [[../tables/pricing_rules]] offer (the model lands in the parent's P1) and is **always owner-approved** because it bleeds margin on every renewal. This spec is that lever, wired into the optimizer behind the build-approval gate.

## Phase 1 — the approval-gated offer lever ⏳
- ⏳ planned
- Add an `offer` variant type to the [[storefront-experiment-bandit-framework|M1 framework]] / [[storefront-optimizer-agent|M4 agent]] that, instead of a reversible content patch, proposes a **persist-to-renewal `pricing_rules` offer** — created `proposed`/inactive and surfaced for **owner approval** (the M4 build-approval gate / `pending_actions`), never auto-activated. First-order-only offers stay coupons ([[../tables/coupons]]) on the autonomous path; only persist-to-renewal offers hit this gate.
- On approval, activate the scoped offer for the experiment arm; the M1 bandit runs it vs holdout and attributes outcomes on the predicted-LTV proxy exactly like any other lever (the offer's renewal-margin cost is in the LTV math — [[storefront-ltv-proxy-reconciler|M3]] — so a margin-bleeding offer that wins first-order but loses on LTV is caught).
- Depends on the parent's **P1 offer model** (`pricing_rule_offers` + `resolveSubscriptionPricing` honoring the active offer at renewal) being shipped first — hence `Blocked-by` the parent.

## Phase 2 — guardrails, expiry + rollback ⏳
- ⏳ planned
- A margin floor: the agent may never *propose* (and the owner is warned before approving) an offer whose modeled renewal margin drops below a configured floor; breaching escalates to the [[../functions/growth|Growth director]] + CFO, it is not surfaced as a normal proposal.
- Auto-expire at `ends_at`; on an LTV-proxy or refund-spike regression (M1 auto-rollback), **deactivate the offer** and revert affected subscriptions' renewal pricing to the base `pricing_rules` — with a clear audit trail (a persist-to-renewal offer touched real renewals, so rollback must un-touch them).

## Safety / invariants
- **Never autonomous.** A persist-to-renewal offer is ALWAYS owner-approved before activation (it bleeds margin on every renewal). The agent proposes; the owner disposes. First-order coupons stay autonomous; persist-to-renewal offers do not.
- **Margin-floor hard rail.** No offer below the modeled renewal-margin floor; breaching escalates to Growth + CFO ([[../operational-rules]] § North star). (The floor/expiry/rollback machinery is **Phase 2** of this spec — the guardrails this lever runs behind.)
- **LTV-accounted.** The offer's renewal-margin cost flows into the M3 predicted-LTV proxy, so a first-order win that churns is caught by the reconciler, not rewarded.
- **Compliance.** No misrepresented pricing; honest offer labeling (brand voice + supplement compliance, the goal § hard rails).

## Verification
- Create a `proposed` persist-to-renewal offer scoped to an Amazing Coffee experiment arm → confirm it is **inactive** and surfaces as an M4 owner-approval `pending_actions` card; it does NOT activate autonomously.
- Approve it → expect `status='active'`; place a subscription order on that arm and confirm `resolveSubscriptionPricing` applies the offer **at renewal** (not just first order) for an in-scope sub, and base pricing for an out-of-scope sub.
- Confirm a first-order-only discount still uses the autonomous coupon path ([[../tables/coupons]]) and does NOT hit this gate.
- The offer runs as an M1 arm vs holdout, attributed on the M3 LTV proxy (renewal-margin cost included).
