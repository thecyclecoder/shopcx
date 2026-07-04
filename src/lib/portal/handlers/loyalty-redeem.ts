import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLoyaltySettings,
  getMember,
  getRedemptionTiers,
  validateRedemption,
  spendPoints,
} from "@/lib/loyalty";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

function generateCode(value: number): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let random = "";
  for (let i = 0; i < 6; i++) random += chars[Math.floor(Math.random() * chars.length)];
  return `LOYALTY-${value}-${random}`;
}

const DISCOUNT_CREATE_MUTATION = `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { nodes { code } } } } }
      userErrors { field message }
    }
  }
`;

export const loyaltyRedeem: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const tierIndex = Number(payload?.tierId ?? payload?.tierIndex ?? -1);

  const settings = await getLoyaltySettings(auth.workspaceId);
  if (!settings.enabled) return jsonErr({ error: "loyalty_disabled" }, 400);

  const tiers = getRedemptionTiers(settings);
  if (tierIndex < 0 || tierIndex >= tiers.length) return jsonErr({ error: "invalid_tier" }, 400);
  const tier = tiers[tierIndex];

  const member = await getMember(auth.workspaceId, auth.loggedInCustomerId);
  if (!member) return jsonErr({ error: "member_not_found" }, 404);

  const validation = validateRedemption(member, tier);
  if (!validation.valid) return jsonErr({ error: validation.error || "insufficient_points" }, 400);

  // Get customer name for discount title
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  const firstName = customer?.first_name || "Customer";
  const lastInitial = customer?.last_name ? customer.last_name[0] : "";
  const code = generateCode(tier.discount_value);
  const title = `Loyalty $${tier.discount_value} - ${firstName} ${lastInitial}`.trim();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.coupon_expiry_days);

  try {
    const { shop, accessToken } = await getShopifyCredentials(auth.workspaceId);

    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: DISCOUNT_CREATE_MUTATION,
          variables: {
            basicCodeDiscount: {
              title, code,
              startsAt: new Date().toISOString(),
              endsAt: expiresAt.toISOString(),
              usageLimit: 1,
              appliesOncePerCustomer: true,
              customerSelection: {
                customers: { add: [`gid://shopify/Customer/${member.shopify_customer_id}`] },
              },
              combinesWith: {
                productDiscounts: settings.coupon_combines_product,
                shippingDiscounts: settings.coupon_combines_shipping,
                orderDiscounts: settings.coupon_combines_order,
              },
              customerGets: {
                appliesOnOneTimePurchase: settings.coupon_applies_to !== "subscription",
                appliesOnSubscription: settings.coupon_applies_to !== "one_time",
                items: { all: true },
                value: { discountAmount: { amount: tier.discount_value, appliesOnEachItem: false } },
              },
            },
          },
        }),
      },
    );

    if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);

    const gqlResult = await res.json();
    const userErrors = gqlResult?.data?.discountCodeBasicCreate?.userErrors;
    if (userErrors?.length > 0) {
      return jsonErr({ error: userErrors.map((e: { message: string }) => e.message).join(", ") }, 400);
    }

    const discountNodeId = gqlResult?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;

    await spendPoints(member, tier.points_cost, `Redeemed ${tier.label}`, discountNodeId);

    const admin = createAdminClient();
    await admin.from("loyalty_redemptions").insert({
      workspace_id: auth.workspaceId,
      member_id: member.id,
      reward_tier: tier.label,
      points_spent: tier.points_cost,
      discount_code: code,
      shopify_discount_id: discountNodeId,
      discount_value: tier.discount_value,
      status: "active",
      expires_at: expiresAt.toISOString(),
    });

    return jsonOk({
      ok: true, route, code,
      discount_value: tier.discount_value,
      expires_at: expiresAt.toISOString(),
      new_balance: member.points_balance - tier.points_cost,
    });
  } catch (err) {
    return jsonErr({ error: err instanceof Error ? err.message : "Redemption failed" }, 500);
  }
};
