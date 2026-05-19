/**
 * Loyalty coupon state probe — used by recipes that need to know what
 * coupons exist for a customer, which are currently applied to which
 * subscriptions, and which are actually used per Shopify (our DB's
 * `loyalty_redemptions.status` column lags behind Shopify's real
 * `asyncUsageCount`).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type Admin = ReturnType<typeof createAdminClient>;

export interface LoyaltyCouponState {
  code: string;
  redemption_id: string;
  shopify_discount_id: string;
  /** Our DB's view. */
  db_status: string;
  /** Shopify's authoritative view: 0/1 = unused, 1/1 = used. */
  shopify_usage_count: number;
  shopify_usage_limit: number | null;
  shopify_status: string;          // 'ACTIVE' | 'EXPIRED' | 'SCHEDULED'
  expires_at: string | null;
  discount_value: number;
  /** True if currently applied to one of the customer's subs. */
  applied_to_contract_id: string | null;
  /** True if Shopify says it's been redeemed at checkout. */
  used: boolean;
  /** True if not used AND not currently applied to any sub. */
  available: boolean;
}

export interface SubscriptionDiscountState {
  contract_id: string;
  status: string;
  next_billing_date: string | null;
  items_summary: string;
  /** Codes currently on this sub per our DB. */
  applied_discount_codes: string[];
}

/**
 * Get the full loyalty + subscription discount state for a customer.
 * Walks linked accounts so siblings' loyalty/subs are visible.
 */
export async function getLoyaltyAndSubState(workspaceId: string, customerId: string): Promise<{
  member: { id: string; points_balance: number } | null;
  coupons: LoyaltyCouponState[];
  subscriptions: SubscriptionDiscountState[];
}> {
  const admin = createAdminClient();

  // Resolve linked customer ids (DATABASE.md pattern)
  const linkedIds = await resolveLinkedIds(admin, customerId);

  const [{ data: member }, { data: reds }, { data: subs }] = await Promise.all([
    admin.from("loyalty_members")
      .select("id, points_balance")
      .eq("workspace_id", workspaceId)
      .in("customer_id", linkedIds)
      .order("points_balance", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin.from("loyalty_redemptions")
      .select("id, member_id, discount_code, shopify_discount_id, status, discount_value, expires_at")
      .order("created_at", { ascending: false })
      .limit(50),
    admin.from("subscriptions")
      .select("shopify_contract_id, status, next_billing_date, items, applied_discounts")
      .eq("workspace_id", workspaceId)
      .in("customer_id", linkedIds)
      .in("status", ["active", "paused"]),
  ]);

  // Filter redemptions to those belonging to the resolved member
  const memberRedemptions = (reds || []).filter(r => member && r.member_id === member.id);

  const subStates: SubscriptionDiscountState[] = (subs || []).map(s => {
    const codes = ((s.applied_discounts as Array<{ title?: string }> | null) || [])
      .map(d => d.title || "")
      .filter(Boolean);
    return {
      contract_id: s.shopify_contract_id as string,
      status: s.status as string,
      next_billing_date: s.next_billing_date as string | null,
      items_summary: ((s.items as Array<{ title?: string; variant_title?: string; quantity?: number }> | null) || [])
        .map(i => `${i.quantity || 1}x ${i.title || ""}${i.variant_title ? ` (${i.variant_title})` : ""}`)
        .join("; "),
      applied_discount_codes: codes,
    };
  });

  // For each redemption, cross-check Shopify for the real usage count.
  // Batch sequentially — there are usually < 20 per customer.
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);
  const coupons: LoyaltyCouponState[] = [];
  for (const r of memberRedemptions) {
    const shopifyState = await fetchShopifyDiscountState(shop, accessToken, r.shopify_discount_id as string);
    const appliedToContract = subStates.find(s => s.applied_discount_codes.includes(r.discount_code as string))?.contract_id || null;
    const used = (shopifyState?.usageCount || 0) > 0;
    coupons.push({
      code: r.discount_code as string,
      redemption_id: r.id as string,
      shopify_discount_id: r.shopify_discount_id as string,
      db_status: r.status as string,
      shopify_usage_count: shopifyState?.usageCount ?? 0,
      shopify_usage_limit: shopifyState?.usageLimit ?? null,
      shopify_status: shopifyState?.status ?? "UNKNOWN",
      expires_at: r.expires_at as string | null,
      discount_value: Number(r.discount_value || 0),
      applied_to_contract_id: appliedToContract,
      used,
      available: !used && !appliedToContract && (shopifyState?.status === "ACTIVE"),
    });
  }

  return {
    member: member ? { id: member.id as string, points_balance: Number(member.points_balance || 0) } : null,
    coupons,
    subscriptions: subStates,
  };
}

async function fetchShopifyDiscountState(
  shop: string,
  accessToken: string,
  discountNodeId: string,
): Promise<{ status: string; usageCount: number; usageLimit: number | null } | null> {
  if (!discountNodeId) return null;
  try {
    const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($id: ID!) {
          codeDiscountNode(id: $id) {
            codeDiscount {
              ... on DiscountCodeBasic {
                status asyncUsageCount usageLimit
              }
            }
          }
        }`,
        variables: { id: discountNodeId },
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const cd = d.data?.codeDiscountNode?.codeDiscount;
    if (!cd) return null;
    return {
      status: cd.status as string,
      usageCount: cd.asyncUsageCount as number,
      usageLimit: cd.usageLimit as number | null,
    };
  } catch {
    return null;
  }
}

async function resolveLinkedIds(admin: Admin, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: g } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  return (g || []).map(r => r.customer_id as string);
}
