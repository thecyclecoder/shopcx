import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
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

export const loyaltyApplyToSubscription: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const redemptionId = typeof payload?.redemptionId === "string" ? payload.redemptionId : null;
  const tierIndex = payload?.tierId != null ? Number(payload.tierId) : null;

  if (!redemptionId && tierIndex == null) {
    return jsonErr({ error: "redemptionId_or_tierId_required" }, 400);
  }

  const admin = createAdminClient();
  const settings = await getLoyaltySettings(auth.workspaceId);
  if (!settings.enabled) return jsonErr({ error: "loyalty_disabled" }, 400);

  let code: string;
  let discountValue: number;

  if (redemptionId) {
    // Use existing unused coupon
    const { data: redemption } = await admin.from("loyalty_redemptions")
      .select("id, discount_code, discount_value, status, expires_at")
      .eq("id", redemptionId)
      .eq("workspace_id", auth.workspaceId)
      .single();

    if (!redemption) return jsonErr({ error: "redemption_not_found" }, 404);
    if (redemption.status !== "active") return jsonErr({ error: "coupon_not_available" }, 400);
    if (new Date(redemption.expires_at) < new Date()) return jsonErr({ error: "coupon_expired" }, 400);

    code = redemption.discount_code;
    discountValue = Number(redemption.discount_value);
  } else {
    // Redeem first, then apply
    const member = await getMember(auth.workspaceId, auth.loggedInCustomerId);
    if (!member) return jsonErr({ error: "member_not_found" }, 404);

    const tiers = getRedemptionTiers(settings);
    if (tierIndex! < 0 || tierIndex! >= tiers.length) return jsonErr({ error: "invalid_tier" }, 400);
    const tier = tiers[tierIndex!];

    const validation = validateRedemption(member, tier);
    if (!validation.valid) return jsonErr({ error: validation.error || "insufficient_points" }, 400);

    const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
    const firstName = customer?.first_name || "Customer";
    const lastInitial = customer?.last_name ? customer.last_name[0] : "";
    code = generateCode(tier.discount_value);
    discountValue = tier.discount_value;
    const title = `Loyalty $${tier.discount_value} - ${firstName} ${lastInitial} (${code})`.trim();

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + settings.coupon_expiry_days);

    try {
      const { shop, accessToken } = await getShopifyCredentials(auth.workspaceId);
      const res = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
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
      await spendPoints(member, tier.points_cost, `Redeemed ${tier.label} + applied`, discountNodeId);

      // Insert redemption as 'applied' directly (skipping 'active' since we're applying immediately)
      await admin.from("loyalty_redemptions").insert({
        workspace_id: auth.workspaceId,
        member_id: member.id,
        reward_tier: tier.label,
        points_spent: tier.points_cost,
        discount_code: code,
        shopify_discount_id: discountNodeId,
        discount_value: tier.discount_value,
        status: "applied",
        expires_at: expiresAt.toISOString(),
      });
    } catch (err) {
      return jsonErr({ error: err instanceof Error ? err.message : "Redemption failed" }, 500);
    }
  }

  // Release any previously applied loyalty coupons back to 'active'
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    const { data: member } = await admin.from("loyalty_members")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_customer_id", auth.loggedInCustomerId)
      .single();
    if (member) {
      await admin.from("loyalty_redemptions")
        .update({ status: "active" })
        .eq("workspace_id", auth.workspaceId)
        .eq("member_id", member.id)
        .eq("status", "applied");
    }
  }

  // Apply coupon to subscription via Appstle (remove existing first — only 1 coupon per subscription)
  try {
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    const result = await applyDiscountWithReplace(apiKey, String(contractId), code);
    if (!result.success) {
      return jsonErr({ error: "coupon_apply_failed", message: result.error }, 502);
    }
  } catch (e) {
    return handleAppstleError(e);
  }

  // Mark redemption as 'applied' (if it was from an existing coupon)
  if (redemptionId) {
    await admin.from("loyalty_redemptions")
      .update({ status: "applied" })
      .eq("id", redemptionId);
  }

  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.loyalty.applied",
      summary: `Applied loyalty coupon ${code} ($${discountValue} off) to subscription`,
      properties: { shopify_contract_id: String(contractId), code, discountValue },
    });
  }

  return jsonOk({ ok: true, route, code, discount_value: discountValue });
};
