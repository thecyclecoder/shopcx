/**
 * commerce/types.ts — the canonical view shapes every commerce SDK op returns.
 *
 * A view is what a **Display** op yields for one entity — the fields the current
 * dashboard, portal, and AI hydration paths already read. Ground truth is the
 * brain table pages ([[tables/subscriptions]], [[tables/orders]], [[tables/returns]],
 * [[tables/chargeback_events]], [[tables/fraud_cases]], [[tables/replacements]],
 * [[tables/customers]], [[tables/loyalty_members]], [[tables/crisis_customer_actions]])
 * — every field on a view corresponds to a column on those tables (or a value
 * derived at read time from them, e.g. priced money).
 *
 * Money is always **cents (integer)**; never a float, never undefined. The
 * money-invariant guard lives in `./price.ts` (Phase 2).
 *
 * Ids are UUID strings unless the name says otherwise (`shopify_*` = boundary).
 * Timestamps are ISO 8601 strings.
 *
 * Phase 1 declares the shapes; implementations arrive in M2b/M2c.
 */

// ── Money primitives ────────────────────────────────────────────────

/** An integer cent count. Always defined; use PriceInvariantError to reject undefined. */
export type Cents = number;

/** A `{base_cents, unit_cents}` pair for one priced line. */
export interface PricedLine {
  /** Full MSRP for one unit (strikethrough). */
  base_cents: Cents;
  /** Charged unit price (post S&S + break + override). */
  unit_cents: Cents;
}

/** A discount pill rendered next to the total (Subscribe & Save, Buy 2, Coupon, …). */
export interface DiscountPill {
  kind: "sns" | "break" | "free_shipping" | "coupon" | "renewal_offer";
  label: string;
}

// ── SubscriptionView ────────────────────────────────────────────────

/** One line item on a subscription — catalog reference + resolved money. */
export interface SubscriptionLineView {
  line_id: string;
  variant_id: string;
  product_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  is_gift: boolean;
  /** Grandfathered override (internal subs only). */
  price_override_cents: Cents | null;
  /** Money resolved by ./price.ts — never undefined. */
  base_cents: Cents;
  unit_cents: Cents;
}

/** The one shape every subscription surface (portal, dashboard, AI) hydrates. */
export interface SubscriptionView {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  /** Boundary field — Shopify contract for Appstle-baked subs; empty for internal. */
  shopify_contract_id: string | null;
  status: "active" | "paused" | "cancelled";
  is_internal: boolean;
  comp: boolean;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: "succeeded" | "failed" | "skipped" | null;
  items: SubscriptionLineView[];
  /** Order-level money summary derived by ./price.ts. */
  pricing: SubscriptionPricingView;
  shipping_address: Record<string, unknown> | null;
  shipping_protection_added: boolean;
  shipping_protection_amount_cents: Cents;
  applied_discounts: Array<Record<string, unknown>>;
  pricing_offer_id: string | null;
  payment_method_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionPricingView {
  msrp_cents: Cents;
  subtotal_cents: Cents;
  discount_cents: Cents;
  shipping_cents: Cents;
  protection_cents: Cents;
  tax_cents: Cents | null;
  total_cents: Cents;
  free_shipping: boolean;
  pills: DiscountPill[];
}

// ── OrderView ───────────────────────────────────────────────────────

export interface OrderLineView {
  variant_id: string | null;
  product_id: string | null;
  title: string;
  quantity: number;
  unit_cents: Cents;
  total_cents: Cents;
}

export interface OrderView {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string;
  email: string | null;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  delivery_status: string | null;
  total_cents: Cents;
  tax_cents: Cents;
  shipping_cents: Cents;
  shipping_protection_added: boolean;
  shipping_protection_amount_cents: Cents;
  line_items: OrderLineView[];
  fulfillments: Array<Record<string, unknown>>;
  tracking_number: string | null;
  carrier: string | null;
  shipping_address: Record<string, unknown> | null;
  billing_address: Record<string, unknown> | null;
  created_at: string;
  delivered_at: string | null;
}

// ── ReturnView ──────────────────────────────────────────────────────

export interface ReturnLineView {
  variant_id: string | null;
  title: string;
  quantity: number;
  reason: string | null;
}

export interface ReturnView {
  id: string;
  workspace_id: string;
  order_id: string | null;
  order_number: string;
  customer_id: string | null;
  status: "open" | "label_created" | "in_transit" | "delivered" | "refunded" | "cancelled" | "closed";
  resolution_type: "refund_return" | "store_credit_return" | "refund_no_return" | "store_credit_no_return";
  order_total_cents: Cents;
  label_cost_cents: Cents;
  net_refund_cents: Cents;
  tracking_number: string | null;
  carrier: string | null;
  label_url: string | null;
  return_line_items: ReturnLineView[];
  shipped_at: string | null;
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

// ── ReplacementView ────────────────────────────────────────────────

export interface ReplacementView {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  original_order_id: string | null;
  original_order_number: string | null;
  replacement_order_id: string | null;
  subscription_id: string | null;
  reason: string;
  reason_detail: string | null;
  status: "pending" | "shipped" | "delivered" | "cancelled";
  customer_error: boolean;
  items: Array<{ variant_id: string | null; title: string; quantity: number }>;
  address_validated: boolean;
  subscription_adjusted: boolean;
  new_next_billing_date: string | null;
  created_at: string;
}

// ── CustomerView ────────────────────────────────────────────────────

export interface CustomerView {
  id: string;
  workspace_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  subscription_status: "never" | "active" | "paused" | "cancelled" | string;
  subscription_tenure_days: number;
  total_orders: number;
  ltv_cents: Cents;
  first_order_at: string | null;
  last_order_at: string | null;
  tags: string[];
  addresses: Array<Record<string, unknown>>;
  default_address: Record<string, unknown> | null;
  email_marketing_status: string;
  sms_marketing_status: string;
  portal_banned: boolean;
  is_internal: boolean;
  created_at: string;
}

// ── LoyaltyView ─────────────────────────────────────────────────────

export interface LoyaltyRedemptionTierView {
  points: number;
  value_cents: Cents;
  label: string;
}

export interface LoyaltyView {
  member_id: string;
  workspace_id: string;
  customer_id: string | null;
  points_balance: number;
  points_earned: number;
  points_spent: number;
  dollar_value_cents: Cents;
  redemption_tiers: LoyaltyRedemptionTierView[];
  needs_points_backfill: boolean;
  source: "native" | string;
}

// ── ChargebackView ──────────────────────────────────────────────────

export interface ChargebackView {
  id: string;
  workspace_id: string;
  shopify_dispute_id: string;
  shopify_order_id: string | null;
  customer_id: string | null;
  dispute_type: string;
  reason: string | null;
  network_reason_code: string | null;
  amount_cents: Cents;
  currency: string;
  status: "under_review" | "won" | "lost";
  auto_action_taken: "subscriptions_cancelled" | "flagged_for_review" | "none" | null;
  auto_action_at: string | null;
  evidence_due_by: string | null;
  evidence_sent_on: string | null;
  finalized_on: string | null;
  fraud_case_id: string | null;
  ticket_id: string | null;
  initiated_at: string;
  created_at: string;
}

// ── FraudView ───────────────────────────────────────────────────────

export interface FraudView {
  id: string;
  workspace_id: string;
  rule_id: string | null;
  rule_type: string;
  status: "open" | "reviewing" | "confirmed_fraud" | "dismissed";
  severity: "low" | "medium" | "high" | "critical" | string;
  title: string;
  summary: string | null;
  evidence: Record<string, unknown>;
  customer_ids: string[];
  order_ids: string[];
  orders_held: boolean;
  resolution: string | null;
  first_detected_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  created_at: string;
}

// ── CrisisView ──────────────────────────────────────────────────────

/** One customer's tier state within a crisis (out-of-stock swap flow). */
export interface CrisisCustomerActionView {
  id: string;
  crisis_id: string;
  workspace_id: string;
  subscription_id: string | null;
  customer_id: string | null;
  segment: string;
  current_tier: number;
  tier1_sent_at: string | null;
  tier1_response: string | null;
  tier2_sent_at: string | null;
  original_item: Record<string, unknown> | null;
}

/** The rolled-up crisis view — event + affected customer actions. */
export interface CrisisView {
  id: string;
  workspace_id: string;
  name: string;
  status: "draft" | "live" | "resolved" | string;
  affected_variant_id: string;
  affected_sku: string | null;
  affected_product_title: string | null;
  default_swap_variant_id: string | null;
  tier2_coupon_code: string | null;
  tier2_coupon_percent: number;
  expected_restock_date: string | null;
  lead_time_days: number;
  tier_wait_days: number;
  actions: CrisisCustomerActionView[];
  created_at: string;
}

// ── Operation contract (declared in Phase 4) ────────────────────────
// DisplayOp / MutationOp / Gateway / InternalOrAppstle live here, added by
// Phase 4 of this spec — not this phase. Keep this file focused on view shapes.
