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

export async function getMember(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<LoyaltyMember | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("loyalty_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();
  return data;
}

export async function getMemberByCustomerId(
  workspaceId: string,
  customerId: string,
): Promise<LoyaltyMember | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("loyalty_members")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .single();
  return data;
}

export async function getOrCreateMember(
  workspaceId: string,
  shopifyCustomerId: string,
  email: string,
): Promise<LoyaltyMember> {
  const existing = await getMember(workspaceId, shopifyCustomerId);
  if (existing) return existing;

  const admin = createAdminClient();

  // Resolve customer_id from our customers table
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();

  const { data, error } = await admin
    .from("loyalty_members")
    .upsert(
      {
        workspace_id: workspaceId,
        customer_id: customer?.id || null,
        shopify_customer_id: shopifyCustomerId,
        email,
        source: "native",
      },
      { onConflict: "workspace_id,shopify_customer_id" },
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to create loyalty member: ${error.message}`);
  return data;
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

// ── Points mutations ──

export async function earnPoints(
  member: LoyaltyMember,
  points: number,
  orderId: string | null,
  description: string,
): Promise<void> {
  if (points <= 0) return;
  const admin = createAdminClient();

  await admin.from("loyalty_transactions").insert({
    workspace_id: member.workspace_id,
    member_id: member.id,
    points_change: points,
    type: "earning",
    description,
    order_id: orderId,
  });

  await admin
    .from("loyalty_members")
    .update({
      points_balance: member.points_balance + points,
      points_earned: member.points_earned + points,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
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

  await admin
    .from("loyalty_members")
    .update({
      points_balance: Math.max(0, member.points_balance - points),
      points_spent: member.points_spent + points,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
}

export async function deductPoints(
  member: LoyaltyMember,
  points: number,
  orderId: string | null,
  type: "refund" | "chargeback",
  description: string,
): Promise<void> {
  if (points <= 0) return;
  // Don't let balance go below 0
  const actualDeduction = Math.min(points, member.points_balance);
  if (actualDeduction <= 0) return;

  const admin = createAdminClient();

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
      points_balance: member.points_balance - actualDeduction,
      updated_at: new Date().toISOString(),
    })
    .eq("id", member.id);
}
