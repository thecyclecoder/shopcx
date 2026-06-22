/**
 * Seeds v1 of all five policies (returns, refunds, subscriptions, exchanges,
 * crisis) for the Superfoods workspace. Idempotent — upserts on
 * (workspace_id, slug, version=1).
 *
 * The content here is what was locked in conversation, verbatim. Each policy
 * has:
 *   • customer_summary: customer-facing markdown (renders to storefront)
 *   • internal_summary: AI-facing markdown (injected into orchestrator pre-context)
 *   • rules: structured JSONB the playbook/code reads without AI
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const policies = [
  // ────────────────────────────────────────────────────────────────────────
  {
    slug: "returns",
    name: "Returns Policy",
    customer_summary: `# Returns Policy

## 30-Day Money-Back Guarantee

Our 30-Day Money-Back Guarantee applies **only to your first order ever**. Subscription renewals and additional one-time orders are not eligible.

The 30-day window starts on your **date of purchase** (not delivery).

## What's Eligible

All products you ordered are eligible for return under the Money-Back Guarantee — including damaged or partially-consumed product. You don't need the original packaging in perfect condition.

**Not eligible for refund:**
- Shipping Protection
- Customer-paid shipping costs
- Return shipping label cost

## How It Works

When you initiate a return under the Money-Back Guarantee, we'll send you a prepaid return shipping label by email. The cost of the label is deducted from your refund. Once your return is delivered back to us, we issue your refund — typically within 5–10 business days on your original payment method.

## Limits

We honor one return per customer, for life. This applies across any accounts you may have under different emails or phone numbers.`,
    internal_summary: `# Returns Policy (AI-facing)

## Eligibility
- 30-day Money-Back Guarantee applies ONLY to customer's first order ever.
- Subscription renewals and additional one-time orders are NOT eligible for MBG.
- 30-day window = 30 days from date of purchase (not delivery).
- Order must be fulfilled (shipped) before a return can be initiated. Just-charged unfulfilled orders → tell customer to wait for delivery, then reply for a label.
- Carrier-lost / never-received → use Replacement flow, not Returns.

## Lifetime Limit
- ONE return per customer, lifetime. Applies across all linked customer profiles (same person under multiple emails/phones — the customer_links group).
- Once a customer has used their lifetime return, additional returns require agent approval (escalate).

## Eligible Items / Refund Amount
- Under MBG: all products eligible (including damaged or consumed). Order subtotal is refunded.
- Excluded from refund: Shipping Protection, customer-paid shipping costs, return label costs.
- Refund math: net_refund = order_subtotal − label_cost.

## Who Pays Shipping
- Standard MBG return: we provide a prepaid EasyPost label. Label cost is deducted from refund.
- Crisis returns: we eat the label cost (free for customer). See Crisis Policy.

## Refund Timing
- Refund fires only AFTER EasyPost confirms 'delivered' event back to our warehouse.
- Customer-facing language: "5–10 business days once issued."

## Process / Routing
- All standard returns route through the Refund playbook for eligibility + label issuance.
- EXCEPTION: clear MBG-eligible first-order case → playbook MUST NOT stand-firm. Either bypass to direct create_return, or playbook recognizes MBG eligibility and skips stand-firm.
- EXCEPTION: active crisis tag → direct create_return(free_label=true), skip playbook.
- EXCEPTION: prior agent committed to a return → honor, fire create_return.
- FAILURE: if create_return succeeds but EasyPost label generation fails → escalate, do NOT promise a label.`,
    rules: [
      { id: "returns.mbg_first_order_only", condition: "order.is_first_order = true", window_days: 30, window_start: "purchase_date", action: "eligible" },
      { id: "returns.renewals_not_eligible", condition: "order.source = subscription_contract", action: "deny", reason: "MBG only applies to first order" },
      { id: "returns.additional_one_time_not_eligible", condition: "order.is_first_order = false AND order.source != subscription_contract", action: "deny", reason: "MBG only applies to first order" },
      { id: "returns.fulfilled_required", condition: "order.fulfillment_status != fulfilled", action: "wait_for_delivery" },
      { id: "returns.one_per_customer_lifetime", condition: "linked_customer_group.return_count >= 1", action: "escalate", scope: "across_linked_profiles" },
      { id: "returns.refund_formula", value: "order_subtotal - label_cost" },
      { id: "returns.refund_excludes", value: ["shipping_protection", "customer_paid_shipping", "label_cost"] },
      { id: "returns.refund_fires_on", trigger: "easypost_delivered_event" },
      { id: "returns.customer_facing_timing", value: "5-10 business days" },
      { id: "returns.playbook_skip_standfirm_when_mbg_applies", value: true },
    ],
  },
  // ────────────────────────────────────────────────────────────────────────
  {
    slug: "refunds",
    name: "Refund Policy",
    customer_summary: `# Refund Policy

## What's Covered

Our 30-Day Money-Back Guarantee covers your **first order only**. See our [Returns Policy](/policies/returns) for full details.

For everything beyond the Money-Back Guarantee:

## Subscription Renewals

Subscription renewals are **not refundable** once the charge has processed. You can cancel, pause, or skip future renewals at any time before the next renewal date. We can't process cancellations from a support message — please use the cancel link in any email we've sent, or sign in to your account.

## Charge Errors

If we charged the wrong amount on an order — for example, a coupon that didn't apply at checkout, or an unexpected price difference — contact us and we'll correct the difference.

## Price Increases on Active Subscriptions

Your subscription price stays the same as long as you remain subscribed. If you believe you were overcharged compared to your usual rate, contact us and we'll review.

## Refund Method & Timing

Refunds are issued to your original payment method and typically land within **5–10 business days** of being issued.`,
    internal_summary: `# Refund Policy (AI-facing)

## Subscription Renewal Refundability
- Renewals are CATEGORICALLY DENIED for refund. Customer authorized auto-renew at sub setup.
- Alternatives to offer: cancel future, pause 30 or 60 days, skip next, change frequency.
- Cancellation window: any time before next renewal (NOT 48h). Applies immediately.
- Cancellation method: customer MUST self-serve via portal or cancel link. We never execute cancel from an inbound message.

## Refund Playbook (handles renewal-regret pushback)
- 8 steps: identify order → identify sub → check other subs → explain policy → offer exception → initiate return → cancel sub → stand firm.
- Stand-firm cadence: stand_firm_before_exceptions=2 (deny policy twice before offering Tier 1).
- Stand-firm cadence: stand_firm_between_tiers=2 (deny twice between Tier 1 and Tier 2).
- Max stand-firm responses per ticket: 3.
- Max exceptions per ticket: 2.

## Refund Playbook Exceptions
- Tier 0 — LOYALTY SAVE (new, skip_stand_firm=true):
    Conditions: order.source=subscription_contract AND order.days_since_charge<=7 AND order.has_loyalty_coupon=false AND customer.loyalty_points>=500.
    Resolution: redeem highest tier ($5/$10/$15 from points) as partial refund + offer 30/60 day pause. Customer confirms; we execute redeem_points_as_refund + pause_timed.
    Fires IMMEDIATELY on first eligible turn — no stand-firm required first.
- AUTO-GRANT — System Error (cancelled_but_charged):
    Tag-triggered. Refund immediately, no return needed. Apologize sincerely.
- Tier 1 — Store Credit Return:
    Conditions: ltv_cents >= 10000 OR total_orders >= 1.
    Resolution: return for store credit. Label cost deducted from credit. Frame as "I was able to get an exception approved."
- Tier 2 — Cash Refund Return:
    Conditions: ltv_cents >= 30000 OR total_orders >= 3.
    Resolution: return for cash refund. Label cost deducted from refund. Frame as "I got this upgraded." Only offered after store credit rejected.

## Same-Day Unfulfilled Renewal
- No refund, period. Pause/skip/cancel future renewals only.
- DO NOT auto-issue refunds for "I just got charged today" cases. This was the same-day-void bug.

## Price Discrepancy (Direct, Skip Playbook)
- Customer states specific quoted vs charged price (e.g., "quoted $X, charged $Y", or "coupon didn't apply").
- If difference < $50: direct partial_refund for the exact gap. Reason: "Price adjustment to match quoted price."
- If difference > $50 or amount unclear: ESCALATE (not the playbook).
- Coupon-not-used-this-time (vs. coupon-didn't-apply) is NOT a discrepancy.

## Grandfathered Pricing Overcharge
- Customer says price went up. Compare per-unit "realized" prices across recent renewal orders for the same variant.
- If per-unit matches prior renewals: NOT overcharged. Explain calmly, no refund.
- If per-unit went UP and new price is at-or-near 50% MSRP floor: floor-cleanup. Explain they had a great rate, 50% MSRP is still well below normal. NO REFUND.
- If per-unit went UP beyond what the floor explains: real overcharge. Two actions in same turn:
    1. partial_refund for per-unit diff × quantity on most recent order.
    2. update_line_item_price to restore grandfathered rate. base_price_cents = (prior_realized / 0.75) × 100.
- Use "realized price" with customers, never "base price."

## Refund Methods
- Tier ordering: store credit first (Tier 1), cash refund only at Tier 2 (LTV>=$300 OR orders>=3, after credit rejected).
- Store credit: never expires, any product.
- AI understands "cash refund" = refund-to-card when customer says it, but still follows tier sequence.

## What Does NOT Get a Refund
- Parallel subs customer set up themselves — both charges legitimate, cancel going forward, no refund on prior cycles.
- Change of mind on a renewal that already shipped — pause/skip/cancel future only.
- Coupon-not-used-this-time differences (had a coupon before, not this order).
- "I didn't authorize" claims contradicted by records (signed up + prior renewals processed) — no refund, route to cancel + explain neutrally.`,
    rules: [
      { id: "refunds.renewal_categorically_denied", condition: "order.source = subscription_contract", action: "deny_with_alternatives", alternatives: ["cancel_future", "pause_30d", "pause_60d", "skip_next", "change_frequency"] },
      { id: "refunds.cancellation_window", value: "any_time_before_next_renewal" },
      { id: "refunds.cancellation_method", value: "customer_self_serve_only", note: "Never execute from inbound message; send cancel journey link" },
      { id: "refunds.price_discrepancy_under_50", condition: "difference_cents < 5000 AND customer_stated_expected_price", action: "direct_partial_refund" },
      { id: "refunds.price_discrepancy_over_50", condition: "difference_cents >= 5000", action: "escalate" },
      { id: "refunds.grandfathered_floor_pct", value: 50, of: "msrp" },
      { id: "refunds.grandfathered_base_formula", value: "realized_per_unit / 0.75 * 100" },
      { id: "refunds.timing_to_customer", value: "5-10 business days" },
      { id: "refunds.playbook_id", value: "3bf880db-dbc8-418e-8a6d-471ddc5ebc3a" },
      { id: "refunds.playbook_stand_firm_max", value: 3 },
      { id: "refunds.playbook_stand_firm_before_exceptions", value: 2 },
      { id: "refunds.playbook_stand_firm_between_tiers", value: 2 },
      { id: "refunds.tier_1_threshold", condition: "ltv_cents >= 10000 OR total_orders >= 1", resolution: "store_credit_return" },
      { id: "refunds.tier_2_threshold", condition: "ltv_cents >= 30000 OR total_orders >= 3", resolution: "refund_return" },
      { id: "refunds.tier_0_loyalty_save", condition: "order.source = subscription_contract AND order.days_since_charge <= 7 AND NOT order.has_loyalty_coupon AND customer.loyalty_points >= 500", resolution: "loyalty_redeem_partial_refund + pause_30_or_60_offer", skip_stand_firm: true },
    ],
  },
  // ────────────────────────────────────────────────────────────────────────
  {
    slug: "subscriptions",
    name: "Subscription Policy",
    customer_summary: `# Subscription Policy

## How Subscriptions Work

Subscriptions automatically renew on the cadence you choose — **Twice a Month**, **Monthly**, or **Every 2 Months**. Subscribers save 25% off retail on every order.

## Subscriber Benefits

As a subscriber you get:
- **25% off every order**
- **Free shipping** on every subscription order, no minimum
- **Price lock** — your subscription price stays the same on future renewals even if our website price increases
- **Priority access to inventory** — if a product runs low, subscribers continue to receive it first

## Cancellation

You can cancel anytime before your next renewal — your cancellation applies immediately. Use the cancel link in any email we've sent, or sign in to your account. Customer support cannot process cancellations directly — this ensures the right subscription is cancelled on your account.

## Pause & Skip

Need a break? Pause your subscription for 30 or 60 days, or skip just the next order. Pauses resume automatically; skip keeps your regular schedule going after the next cycle. Consecutive pauses are allowed — just trigger a new one when the prior expires.

## Making Changes

Make changes anytime in the portal — change frequency, swap a flavor, add or remove items, adjust quantities, apply a discount code, or update your shipping address. All items on your subscription get the 25% subscriber discount. One discount code at a time.

**Payment method changes** must be done by you in your account — we can't update payment methods on your behalf.

**Address changes** apply to your next order — once an order has gone to our fulfillment center, we can't redirect it.

## Payment & Billing

We'll attempt your renewal charge on your scheduled renewal date. If a card fails, we'll continue to attempt the charge for up to 30 days. If it still hasn't gone through, we'll pause your subscription until you update your payment method.`,
    internal_summary: `# Subscription Policy (AI-facing)

## Frequency & Discount
- Frequencies (internal): 2, 4, 8 weeks.
- Customer-facing frequency labels: 2wk="Twice a Month", 4wk="Monthly", 8wk="Every 2 Months". NEVER use "every 4 weeks" etc. in customer messages.
- Standard subscriber discount: 25% off MSRP.
- 50% MSRP floor: absolute minimum realized price. Below-floor historicals were raised to floor (one-time cleanup).
- Standard subscription price = MSRP × 0.75.

## Benefits
- 25% off every order.
- Free shipping on every subscription order, no minimum.
- Price lock: applies as long as customer stays subscribed AND to the specific product/variant combo. Swapping to different variant resets lock to current price. Cancellation + re-sub = new price.
- Priority inventory: when stock runs low, we remove product from website. Subscribers continue receiving until supply exhausted, then crisis swap kicks in.

## Cancellation
- Window: any time before next renewal. Applies immediately.
- Method: customer self-serve only (portal or cancel link). NEVER execute cancel from inbound message.
- Cancel journey IS the self-serve cancel link.
- Reactivation: free, any time, via portal.

## Pause & Skip
- Pause durations: 30 or 60 days only. NEVER offer indefinite pause.
- Skip: skip next order, regular schedule resumes after.
- Auto-resume: pauses set via pause_timed auto-resume after window expires.
- Crisis pause: crisis_pause has auto_resume=true, resumes when crisis resolves (regardless of duration).
- No cap on consecutive pauses — each must be manually triggered (no chained-pause action).

## Modifications (allowed actions)
- change_frequency, change_next_date, swap_variant, add_item, remove_item, change_quantity, update_line_item_price (AI/admin only), apply_coupon, remove_coupon, update_shipping_address.
- ONE coupon per subscription at a time — never stack.
- Subscriber discount applies to ALL line items added to a sub.
- Payment method changes: customer-only (no AI action for this).
- Address changes: cannot mid-flight (Amplifier locks). Customer-facing language is "applies to next order."
- AI-facing exception: if order is in-flight (at Amplifier) and address needs to change, AI MAY offer goodwill replacement to new address at our cost. Discretionary, not a customer-facing entitlement.

## Payment & Billing (Dunning)
- Card rotation: try all stored payment methods (deduped by last4+expiry) at 2-hour intervals.
- After cards exhausted: payday-aware retries on 1st, 15th, Fridays, last business day, at 7 AM Central.
- Cycle 1 default action: skip order. Customer sent payment-update email.
- Cycle 2 default action: pause subscription. Ticket + dashboard notification created.
- New card via Shopify customer_payment_methods webhook → unskip + switch + bill immediately.
- Dunning charges that eventually succeed are NOT refundable.
- Customer-facing language: "we'll attempt for up to 30 days, then pause." Don't expose dunning methodology.`,
    rules: [
      { id: "subs.frequencies_weeks", value: [2, 4, 8] },
      { id: "subs.frequency_labels", value: { "2": "Twice a Month", "4": "Monthly", "8": "Every 2 Months" } },
      { id: "subs.discount_pct", value: 25 },
      { id: "subs.floor_pct", value: 50, of: "msrp" },
      { id: "subs.free_shipping", value: true, threshold_cents: 0 },
      { id: "subs.cancellation_window", value: "any_time_before_next_renewal" },
      { id: "subs.cancellation_method", value: "customer_self_serve_only" },
      { id: "subs.pause_durations_days", value: [30, 60] },
      { id: "subs.pause_indefinite_allowed", value: false },
      { id: "subs.coupon_stacking_allowed", value: false },
      { id: "subs.dunning_max_days", value: 30 },
      { id: "subs.dunning_cycle_1_action", value: "skip" },
      { id: "subs.dunning_cycle_2_action", value: "pause" },
      { id: "subs.dunning_success_refundable", value: false },
      { id: "subs.price_lock_scope", value: "product_variant_combo", invalidated_by: ["variant_swap", "cancel_and_resubscribe"] },
    ],
  },
  // ────────────────────────────────────────────────────────────────────────
  {
    slug: "exchanges",
    name: "Exchange & Replacement Policy",
    customer_summary: `# Exchange & Replacement Policy

## Shipping Protection Coverage

If you purchase **Shipping Protection** at checkout, we can issue free replacements for items that arrive **damaged**, **expired**, **missing from your order**, or **never delivered**. Shipping Protection is added during checkout and covers your full order.

## How Replacements Work

We'll send your free replacement right away — you don't have to wait for any return to be received.

For items that arrived damaged or expired, we'll also include a prepaid return label so you can send the original back when it's convenient. There's nothing more for you to pay.

For items missing from your order or never delivered, there's nothing to return — we just ship the replacement.

## Allergies & Safety

If you received the wrong product and have an allergy or medical reaction, contact us right away — your replacement or refund will be handled immediately.`,
    internal_summary: `# Exchange & Replacement Policy (AI-facing)

## CRITICAL: Shipping-Protection Framing is Marketing-Only
The customer-facing copy says "if you purchase Shipping Protection." DO NOT enforce this. We issue replacements for all valid triggers regardless of whether Shipping Protection was on the order. The framing exists to drive Shipping Protection adoption — it is NOT an actual gate.
NEVER tell a customer "you don't have Shipping Protection" or deny on those grounds.

## Valid Replacement Triggers
1. Damaged on arrival
2. Missing item (shipped less than billed)
3. Expired / near-expiration product (any "expires soon" or short shelf-life complaint)
4. Never received / carrier-lost (delivery confirmed but customer doesn't have it)
5. Allergy/safety override — customer reports an allergy/medical reaction. SAFETY-CRITICAL anomaly: acknowledge the concern every turn and ESCALATE for human safety review (action_type='escalate'). Do NOT pre-commit a same-turn cash refund or pick the resolution for them. A replacement may be offered if the customer explicitly wants one (see matrix); any cash refund routes through the Refund playbook (return required on a fulfilled order; void/cancel an unfulfilled order — never refund-to-card without a return).
6. Recurring fulfillment issue (same item missing across 2+ consecutive renewals)

## NOT a Replacement Trigger
- "Wrong item" complaints — warehouse never sends wrong items (barcode-scanned). Wrong-item claims are 100% crisis customers. Check active crisis → enroll on the fly via crisis_enroll if eligible → continue as crisis. If no active crisis match, ESCALATE (rare; likely customer-side confusion).
- Crisis swap acceptance (handled by Crisis Policy).

## Replacement Cost
- Free for the customer. We pay shipping + product cost.
- Replacement is item-for-item (same SKU/variant, same quantity) by default.
- Customer can request a flavor swap on the replacement.

## Return Requirement (after replacement ships)
- We always WANT the original returned (except where there is no physical item — missing-from-box, never received, recurring fulfillment).
- Issue prepaid EasyPost return label same turn as replacement.
- Set returns.net_refund_cents = 0 — the replacement IS the refund. No money moves on the return.
- Return is for inventory audit and quality control, not financial.

## Return-required matrix
- Damaged → YES, prepaid label, refund_amount=0
- Missing → NO (no item to return)
- Expired → YES, prepaid label, refund_amount=0
- Never received → NO (no item exists)
- Allergy/safety (replacement chosen) → YES, prepaid label, refund_amount=0
- Allergy/safety (refund/cash chosen) → ESCALATE for human safety review first. NO refund-to-card without a return: route any approved cash refund through the Refund playbook — return required on a fulfilled order; void/cancel an UNFULFILLED (never-shipped) order instead of refunding-to-card.
- Recurring fulfillment → NO (re-fulfillment, no defective item)

## Limits & Escalation
- Replacements over 2 units → ESCALATE. AI summarizes what needs to be replaced + creates the escalation. Agent reviews. Future: agent leaves internal note "replacement approved" → AI executes.

## Allergy Override Priority
- Allergy/medical reaction in the customer's message: HIGHEST PRIORITY for acknowledgment + safety — but a genuine reaction is a safety-critical anomaly, NOT a self-serve refund trigger (tickets are anomalies: do NOT pre-commit a refund or replacement). Required behavior: (1) acknowledge the safety concern warmly, every turn; (2) action_type='escalate' for human safety review, escalation_reason "allergy/safety report — needs immediate review"; (3) NEVER auto-issue a same-turn cash refund to the card, and NEVER close as resolved without human review. A replacement may be offered only if the customer explicitly wants one (prepaid return + refund_amount=0, see matrix). Any cash refund — including an unwanted-renewal dispute riding on the same ticket — goes through the Refund playbook, which requires a return on a fulfilled order and voids/cancels an UNFULFILLED (never-shipped) order rather than refunding-to-card.`,
    rules: [
      { id: "exchanges.shipping_protection_required", value: false, note: "Marketing framing only; never enforced" },
      { id: "exchanges.valid_triggers", value: ["damaged", "missing", "expired", "never_received", "allergy_safety", "recurring_fulfillment"] },
      { id: "exchanges.wrong_item_handling", action: "check_crisis_then_enroll_or_escalate" },
      { id: "exchanges.return_required_by_trigger", value: { damaged: true, missing: false, expired: true, never_received: false, allergy_safety: true, recurring_fulfillment: false } },
      { id: "exchanges.refund_amount_on_return", value: 0, note: "Replacement IS the refund; return is for inventory only" },
      { id: "exchanges.unit_escalation_threshold", value: 2 },
      { id: "exchanges.allergy_override_priority", value: "highest", action: "escalate", note: "Acknowledge safety + escalate for human review; never auto cash refund; replacement optional same turn; cash refund only via Refund playbook (return on fulfilled, void/cancel on unfulfilled)" },
      { id: "exchanges.allergy_refund_requires_return", value: true, note: "No refund-to-card on an allergy report without a return. Fulfilled → return via Refund playbook; unfulfilled → void/cancel; genuine reaction → escalate for human safety review." },
      { id: "exchanges.playbook_id", value: "0937d507-82ea-4d04-a4eb-c69b169255e3" },
    ],
  },
  // ────────────────────────────────────────────────────────────────────────
  {
    slug: "crisis",
    name: "Crisis (Out-of-Stock) Policy",
    customer_summary: `# Out-of-Stock Policy

## Substitutions When a Product Runs Out

If a product you subscribe to runs out of stock, we'll send you the **closest available flavor or product** to keep your subscription on track — and reach out by email so you can pick a different option, pause your subscription, or get a refund if you'd rather.

## What Happens When the Original Is Back

When the original product is back, we'll automatically restart your paused subscription, add the item back to your subscription if it was removed, or switch you back from the substitute — and email you to let you know.

## If You're Not Happy with the Substitute

You have options:
- Pick a **different flavor or product** from what's available
- **Pause** your subscription until the original is back
- **Return the substitute** for a full refund — we'll send you a free prepaid shipping label

Just reply to the notification email or contact us.`,
    internal_summary: `# Crisis (Out-of-Stock) Policy (AI-facing)

## Trigger
- Admin creates a crisis_events row when a variant goes OOS. The daily crisis-campaign cron auto-enrolls affected subscribers (subs containing the affected variant).

## 3-Tier Campaign
- Tier 1: Flavor swap. Auto-swap fires BEFORE customer responds — sub is switched to default substitute so next order ships with substitute. Customer can choose a different flavor via the journey, or "I'd rather cancel."
- Tier 2: Product swap + coupon (default 20% off). Different product entirely. Sent if customer rejected Tier 1.
- Tier 3: Pause or Remove. Berry-only subs: pause + auto-resume on restock. Berry+others: remove the OOS item, keep the rest, auto-readd on restock.

## Customer Asks "Why Did I Get X?"
- We ALREADY notified them at Tier 1. DO NOT apologize a second time. DO NOT pre-emptively offer Tier 2 coupon (e.g., OOSMB-*) — that's reserved for explicit rejection.
- Frame factually: "Our Mixed Berry is temporarily out of stock — expecting it back [date]. We shipped [substitute] so you wouldn't miss a shipment. A few options: pause until restock, swap to a different flavor, or set up a free return."

## Crisis Refund / Return Path
- All crisis-confirmed customers get the WHITE-GLOVE direct path. No tenure check. No playbook routing.
- create_return(free_label=true) for the substitute order. We eat the label cost.
- Refund fires when EasyPost confirms 'delivered' back to our warehouse.
- "Crisis-confirmed" = get_crisis_status returns active enrollment OR customer's recent order contains the swap variant during an active crisis.

## Wrong-Item Claim WITHOUT Active Crisis
- Most likely a crisis customer that hasn't been auto-tagged yet.
- Check if customer's order/subscription contains an impacted SKU of an active crisis. If YES → crisis_enroll(contract_id) on the fly → continue as crisis-confirmed.
- If NO impacted SKU match: ESCALATE. Warehouse barcode-scans guarantee no pick errors; rare = customer confusion or fraud.

## Resolution (When Crisis Ends)
- Bulk operations, no asking permission:
  1. Auto-resume paused subs. Email customer.
  2. Auto-readd removed items to subs. Email customer.
  3. Auto-swap-back substitute customers to their original. Email customer.
- Customers who prefer the substitute can self-serve change in the portal.

## Customer-Facing Constraints
- Don't expose tier numbers, coupon names, or campaign timing.
- Customer sees normal email exchange. The 3-tier structure is invisible to them.`,
    rules: [
      { id: "crisis.tier_count", value: 3 },
      { id: "crisis.tier_1_default_action", value: "auto_swap_to_default_substitute_before_response" },
      { id: "crisis.tier_2_default_coupon_pct", value: 20 },
      { id: "crisis.tier_3_berry_only_action", value: "pause_with_auto_resume" },
      { id: "crisis.tier_3_berry_plus_others_action", value: "remove_with_auto_readd" },
      { id: "crisis.return_path", value: "white_glove_direct", route: "create_return(free_label=true)" },
      { id: "crisis.tenure_check_for_returns", value: false, note: "Dropped — all crisis-confirmed customers get the direct path" },
      { id: "crisis.refund_fires_on", trigger: "easypost_delivered_event" },
      { id: "crisis.confirmed_definition", value: "active enrollment OR recent order contains swap variant during active crisis" },
      { id: "crisis.wrong_item_without_active_crisis", action: "check_sku_match_then_enroll_or_escalate" },
      { id: "crisis.resolution_actions_bulk", value: ["auto_resume_paused", "auto_readd_removed", "auto_swap_back_substitute"] },
      { id: "crisis.dont_apologize_for_swap_notification", value: true },
      { id: "crisis.dont_preempt_tier_2_coupon", value: true },
    ],
  },
];

async function main() {
  for (const p of policies) {
    const { data: existing } = await admin
      .from("policies")
      .select("id, version")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("slug", p.slug)
      .eq("version", 1)
      .maybeSingle();

    if (existing) {
      // Update v1 in place rather than versioning forward — this is the initial seed.
      const { error } = await admin
        .from("policies")
        .update({
          name: p.name,
          customer_summary: p.customer_summary,
          internal_summary: p.internal_summary,
          rules: p.rules,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (error) throw error;
      console.log(`✓ updated ${p.slug} (v1)`);
    } else {
      const { error } = await admin
        .from("policies")
        .insert({
          workspace_id: WORKSPACE_ID,
          slug: p.slug,
          name: p.name,
          version: 1,
          customer_summary: p.customer_summary,
          internal_summary: p.internal_summary,
          rules: p.rules,
        });
      if (error) throw error;
      console.log(`✓ inserted ${p.slug} (v1)`);
    }
  }

  // Verify
  const { data: all } = await admin
    .from("policies")
    .select("slug, name, version, length(customer_summary) as customer_len, length(internal_summary) as internal_len, jsonb_array_length(rules) as rule_count")
    .eq("workspace_id", WORKSPACE_ID)
    .order("slug");
  console.log("\nSeeded policies:");
  for (const p of all || []) console.log(`  ${p.slug} v${p.version} — ${p.name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
