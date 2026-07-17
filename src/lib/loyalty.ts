/**
 * Core loyalty logic — earning, spending, validation, calculations.
 * Native engine: no third-party provider. All points managed in our DB,
 * redemptions create Shopify discount codes.
 */

import { createAdminClient } from "@/lib/supabase/admin";

// ── Types ──

export interface LoyaltyMember {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_customer_id: string | null;
  email: string | null;
  points_balance: number;
  points_earned: number;
  points_spent: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface RedemptionTier {
  label: string;
  points_cost: number;
  discount_value: number;
}

export interface LoyaltySettings {
  workspace_id: string;
  enabled: boolean;
  points_per_dollar: number;
  points_per_dollar_value: number;
  redemption_tiers: RedemptionTier[];
  coupon_applies_to: string;
  coupon_combines_product: boolean;
  coupon_combines_shipping: boolean;
  coupon_combines_order: boolean;
  coupon_expiry_days: number;
  exclude_tax: boolean;
  exclude_discounts: boolean;
  exclude_shipping: boolean;
  exclude_shipping_protection: boolean;
}

// ── Settings ──

const DEFAULT_SETTINGS: Omit<LoyaltySettings, "workspace_id"> = {
  enabled: false,
  points_per_dollar: 10,
  points_per_dollar_value: 100,
  redemption_tiers: [
    { label: "$5 Off", points_cost: 500, discount_value: 5 },
    { label: "$10 Off", points_cost: 1000, discount_value: 10 },
    { label: "$15 Off", points_cost: 1500, discount_value: 15 },
  ],
  coupon_applies_to: "both",
  coupon_combines_product: true,
  coupon_combines_shipping: true,
  coupon_combines_order: false,
  coupon_expiry_days: 90,
  exclude_tax: true,
  exclude_discounts: true,
  exclude_shipping: true,
  exclude_shipping_protection: true,
};

export async function getLoyaltySettings(workspaceId: string): Promise<LoyaltySettings> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("loyalty_settings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .single();

  if (!data) {
    return { workspace_id: workspaceId, ...DEFAULT_SETTINGS };
  }

  return {
    ...data,
    // Parse JSONB tiers if stored as string
    redemption_tiers: typeof data.redemption_tiers === "string"
      ? JSON.parse(data.redemption_tiers)
      : data.redemption_tiers || DEFAULT_SETTINGS.redemption_tiers,
  };
}

// ── Member lookup ──

/**
 * Expand a customer_id to all linked profile IDs in the same group.
 * Loyalty records may live on any sibling profile (e.g. tbaxtel@me.com
 * has the record but tbaxtel@hotmail.com / @gmail.com don't), so every
 * lookup goes through the link group.
 */
async function expandLinkedCustomerIds(
  workspaceId: string,
  customerId: string,
): Promise<string[]> {
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: peers } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .eq("group_id", link.group_id);
  const ids = new Set<string>([customerId]);
  for (const p of peers || []) if (p.customer_id) ids.add(p.customer_id);
  return [...ids];
}

/**
 * Linked accounts = one person, so loyalty is unified across the group. Points
 * may be spread over sibling member rows (e.g. earned on one profile, redeemed on
 * another), so the balance is the SUM across the group. The "canonical" member —
 * the biggest current holder — is the identity that writes (earn/spend) target,
 * which also consolidates future activity onto one row.
 */
function aggregateLinkedMembers(rows: LoyaltyMember[]): LoyaltyMember | null {
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const canonical = rows.reduce((a, b) => (Number(b.points_balance || 0) > Number(a.points_balance || 0) ? b : a));
  const points_balance = rows.reduce((s, m) => s + Number(m.points_balance || 0), 0);
  const points_earned = rows.reduce((s, m) => s + Number(m.points_earned || 0), 0);
  return { ...canonical, points_balance, points_earned };
}

export async function getMember(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<LoyaltyMember | null> {
  const admin = createAdminClient();
  // Resolve the customer for this Shopify id, then aggregate the WHOLE link group.
  // (The old fast-path returned the direct shopify-id member even when it held 0
  // points and a linked sibling held the balance — the linked-accounts bug.)
  const { data: cust } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (!cust?.id) {
    // No customer row — fall back to a direct Shopify-id match.
    const { data } = await admin
      .from("loyalty_members")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("shopify_customer_id", shopifyCustomerId)
      .maybeSingle();
    return data || null;
  }
  const linkedIds = await expandLinkedCustomerIds(workspaceId, cust.id);
  const { data: rows } = await admin
    .from("loyalty_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds);
  return aggregateLinkedMembers(rows || []);
}

export async function getMemberByCustomerId(
  workspaceId: string,
  customerId: string,
): Promise<LoyaltyMember | null> {
  const admin = createAdminClient();
  const linkedIds = await expandLinkedCustomerIds(workspaceId, customerId);
  const { data: rows } = await admin
    .from("loyalty_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .in("customer_id", linkedIds);
  return aggregateLinkedMembers(rows || []);
}

export async function getOrCreateMember(
  workspaceId: string,
  shopifyCustomerId: string,
  email: string,
): Promise<LoyaltyMember> {
  const admin = createAdminClient();

  // Loyalty identity is the customer UUID, never the Shopify id (Shopify is being
  // sunset). Resolve the UUID, look the member up across the UUID link group, and
  // create keyed on customer_id — so earning consolidates onto ONE member per
  // person instead of splitting a new row per Shopify profile.
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();

  const lookupExisting = () =>
    customer?.id
      ? getMemberByCustomerId(workspaceId, customer.id)
      : getMember(workspaceId, shopifyCustomerId);

  const existing = await lookupExisting();
  if (existing) return existing;

  // Upsert (not insert) so two concurrent order-created webhooks — Shopify
  // retries / double-delivers — that both miss the SELECT above don't crash the
  // loser with a Postgres 23505 on UNIQUE(workspace_id, shopify_customer_id).
  // ignoreDuplicates means the winner gets its row back and the loser gets no
  // row; the loser then re-reads the winner below, so a race resolves to a
  // successful get-or-create instead of a failed webhook.
  const { data, error } = await admin
    .from("loyalty_members")
    .upsert(
      {
        workspace_id: workspaceId,
        customer_id: customer?.id || null,
        shopify_customer_id: shopifyCustomerId, // retained for back-compat only
        email,
        source: "native",
      },
      { onConflict: "workspace_id,shopify_customer_id", ignoreDuplicates: true },
    )
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to create loyalty member: ${error.message}`);
  if (data) return data;

  // Lost the race (conflict → no row returned by ignoreDuplicates). Re-read the
  // member the winning insert created and return that.
  const winner = await lookupExisting();
  if (winner) return winner;
  throw new Error("Failed to create loyalty member: no row after upsert conflict");
}

// ── Redemption tiers ──

export function getRedemptionTiers(settings: LoyaltySettings): RedemptionTier[] {
  return settings.redemption_tiers || DEFAULT_SETTINGS.redemption_tiers;
}

export function validateRedemption(
  member: LoyaltyMember,
  tier: RedemptionTier,
): { valid: boolean; error?: string } {
  if (member.points_balance < tier.points_cost) {
    return {
      valid: false,
      error: `Insufficient points. Need ${tier.points_cost}, have ${member.points_balance}`,
    };
  }
  return { valid: true };
}

/**
 * Convert points to dollar value for display.
 * Uses the conversion rate from settings (e.g., 100 points = $1).
 */
export function pointsToDollarValue(points: number, settings: LoyaltySettings): number {
  if (settings.points_per_dollar_value <= 0) return 0;
  return Math.floor((points / settings.points_per_dollar_value) * 100) / 100;
}

// ── Points calculations ──

export interface OrderDeductions {
  tax: number;
  discounts: number;
  shipping: number;
  shippingProtection: number;
}

/**
 * Calculate points earned from an order after applying configured exclusions.
 */
export function calculateEarningPoints(
  lineItemsTotal: number,
  deductions: OrderDeductions,
  settings: LoyaltySettings,
): number {
  let qualifying = lineItemsTotal;
  if (settings.exclude_tax) qualifying -= deductions.tax;
  if (settings.exclude_discounts) qualifying -= deductions.discounts;
  if (settings.exclude_shipping) qualifying -= deductions.shipping;
  if (settings.exclude_shipping_protection) qualifying -= deductions.shippingProtection;
  if (qualifying <= 0) return 0;
  return Math.floor(qualifying * settings.points_per_dollar);
}

// ── Manual-adjustment guard ──

/**
 * Pure predicate that gates the /api/loyalty/members/[memberId] POST route
 * (loyalty-list-stats-and-adjust-guard.md Phase 2). Rejects zero / non-finite
 * deltas and any negative delta that would drive points_balance below zero —
 * so the route returns 4xx instead of silently under-flowing to Math.max(0,…).
 * deductPoints itself re-reads the live balance and clamps as a defense-in-depth
 * layer; this predicate is the fast-fail at the API boundary.
 */
export function validateManualAdjustment(
  currentBalance: number,
  delta: number,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, error: "Points amount required (positive or negative)" };
  }
  if (delta < 0 && currentBalance + delta < 0) {
    return {
      ok: false,
      error: `Adjustment of ${delta} would drive balance below zero (current: ${currentBalance})`,
    };
  }
  return { ok: true };
}

// ── Points mutations ──

export async function earnPoints(
  member: LoyaltyMember,
  points: number,
  orderId: string | null,
  description: string,
  type: "earning" | "adjustment" = "earning",
): Promise<void> {
  if (points <= 0) return;
  const admin = createAdminClient();

  await admin.from("loyalty_transactions").insert({
    workspace_id: member.workspace_id,
    member_id: member.id,
    points_change: points,
    type,
    description,
    order_id: orderId,
  });

  // Re-fetch the current balance — the in-memory `member` argument may
  // be stale (the caller might be looping earnPoints across many orders
  // with the same member object, and arithmetic on `member.points_balance`
  // would just keep overwriting with the original snapshot). Reading the
  // current row each time keeps multi-call backfills accurate.
  const { data: current } = await admin
    .from("loyalty_members")
    .select("points_balance, points_earned")
    .eq("id", member.id)
    .single();
  const curBal = current?.points_balance ?? member.points_balance;
  const curEarned = current?.points_earned ?? member.points_earned;

  await admin
    .from("loyalty_members")
    .update({
      points_balance: curBal + points,
      points_earned: curEarned + points,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
  // Keep the passed-in member object reasonably current for any
  // immediate follow-up logic in the caller.
  member.points_balance = curBal + points;
  member.points_earned = curEarned + points;
}

export async function spendPoints(
  member: LoyaltyMember,
  points: number,
  description: string,
  shopifyDiscountId: string | null,
): Promise<void> {
  if (points <= 0) return;
  const admin = createAdminClient();

  await admin.from("loyalty_transactions").insert({
    workspace_id: member.workspace_id,
    member_id: member.id,
    points_change: -points,
    type: "spending",
    description,
    shopify_discount_id: shopifyDiscountId,
  });

  const { data: current } = await admin
    .from("loyalty_members")
    .select("points_balance, points_spent")
    .eq("id", member.id)
    .single();
  const curBal = current?.points_balance ?? member.points_balance;
  const curSpent = current?.points_spent ?? member.points_spent;

  await admin
    .from("loyalty_members")
    .update({
      points_balance: Math.max(0, curBal - points),
      points_spent: curSpent + points,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
  member.points_balance = Math.max(0, curBal - points);
  member.points_spent = curSpent + points;
}

export async function deductPoints(
  member: LoyaltyMember,
  points: number,
  orderId: string | null,
  type: "refund" | "chargeback" | "adjustment",
  description: string,
): Promise<void> {
  if (points <= 0) return;

  const admin = createAdminClient();

  // Read live balance so multi-call deductions don't keep clamping
  // against a stale snapshot.
  const { data: current } = await admin
    .from("loyalty_members")
    .select("points_balance")
    .eq("id", member.id)
    .single();
  const curBal = current?.points_balance ?? member.points_balance;

  const actualDeduction = Math.min(points, curBal);
  if (actualDeduction <= 0) return;

  await admin.from("loyalty_transactions").insert({
    workspace_id: member.workspace_id,
    member_id: member.id,
    points_change: -actualDeduction,
    type,
    description,
    order_id: orderId,
  });

  await admin
    .from("loyalty_members")
    .update({
      points_balance: curBal - actualDeduction,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
  member.points_balance = curBal - actualDeduction;
}
