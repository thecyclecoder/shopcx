import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub, portalFetch } from "@/lib/portal/helpers";
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

// apply-before-spend — points are only deducted and the redemption only flips to
// 'applied' AFTER the code actually lands on the subscription. A failed apply leaves
// the redemption 'active' (unspent) with its Shopify code intact so a retry reuses it
// instead of minting a fresh code and burning more points. See docs/brain/libraries/loyalty.md.
export const loyaltyApplyToSubscription: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const redemptionId = typeof payload?.redemptionId === "string" ? payload.redemptionId : null;
  const tierIndex = payload?.tierId != null ? Number(payload.tierId) : null;

  if (!redemptionId && tierIndex == null) {
    return jsonErr({ error: "redemptionId_or_tierId_required" }, 400);
  }

  const admin = createAdminClient();
  const settings = await getLoyaltySettings(auth.workspaceId);
  if (!settings.enabled) return jsonErr({ error: "loyalty_disabled" }, 400);

  const now = new Date();

  // The code we will apply + the bookkeeping needed to finalize ONLY on a successful apply.
  let code: string;
  let discountValue: number;
  let member: Awaited<ReturnType<typeof getMember>> | null = null;
  let redemptionRowId: string | null = null; // the loyalty_redemptions row we finalize on success
  let shopifyDiscountId: string | null = null;
  let pointsToSpend = 0; // > 0 only when we still owe a spend (fresh mint / reused-but-unspent row)
  let spendDescription = "";

  if (redemptionId) {
    // Use an existing unused (active) coupon — points were already spent at redeem time.
    const { data: redemption } = await admin.from("loyalty_redemptions")
      .select("id, discount_code, discount_value, status, expires_at, shopify_discount_id")
      .eq("id", redemptionId)
      .eq("workspace_id", auth.workspaceId)
      .single();

    if (!redemption) return jsonErr({ error: "redemption_not_found" }, 404);
    if (redemption.status !== "active") return jsonErr({ error: "coupon_not_available" }, 400);
    if (new Date(redemption.expires_at) < now) return jsonErr({ error: "coupon_expired" }, 400);

    code = redemption.discount_code;
    discountValue = Number(redemption.discount_value);
    redemptionRowId = redemption.id;
    shopifyDiscountId = redemption.shopify_discount_id ?? null;
    // pointsToSpend stays 0 — the atomic redeem→apply contract already spent them.
  } else {
    member = await getMember(auth.workspaceId, auth.loggedInCustomerId);
    if (!member) return jsonErr({ error: "member_not_found" }, 404);

    const tiers = getRedemptionTiers(settings);
    if (tierIndex! < 0 || tierIndex! >= tiers.length) return jsonErr({ error: "invalid_tier" }, 400);
    const tier = tiers[tierIndex!];

    const validation = validateRedemption(member, tier);
    if (!validation.valid) return jsonErr({ error: validation.error || "insufficient_points" }, 400);

    spendDescription = `Redeemed ${tier.label} + applied`;

    // Reuse an existing active, unexpired redemption of the SAME tier before minting a new
    // code — a prior failed apply leaves exactly such a row, so a retry never re-mints.
    const { data: reusable } = await admin.from("loyalty_redemptions")
      .select("id, discount_code, discount_value, shopify_discount_id, points_spent")
      .eq("workspace_id", auth.workspaceId)
      .eq("member_id", member.id)
      .eq("reward_tier", tier.label)
      .eq("status", "active")
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (reusable) {
      code = reusable.discount_code;
      discountValue = Number(reusable.discount_value);
      redemptionRowId = reusable.id;
      shopifyDiscountId = reusable.shopify_discount_id ?? null;
      // If the reused row never had points deducted, we still owe the spend on success.
      pointsToSpend = Number(reusable.points_spent) > 0 ? 0 : tier.points_cost;
    } else {
      // Mint a fresh Shopify discount code — but do NOT spend points or mark applied yet.
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
        const res = await portalFetch(
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

        shopifyDiscountId = gqlResult?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
      } catch (err) {
        return jsonErr({ error: err instanceof Error ? err.message : "Redemption failed" }, 500);
      }

      // Record the minted code as an 'active' (unspent) redemption BEFORE applying, so a
      // failed apply below leaves a reusable row (no re-mint on retry) and zero points spent.
      const { data: inserted } = await admin.from("loyalty_redemptions")
        .insert({
          workspace_id: auth.workspaceId,
          member_id: member.id,
          reward_tier: tier.label,
          points_spent: 0,
          discount_code: code,
          shopify_discount_id: shopifyDiscountId,
          discount_value: tier.discount_value,
          status: "active",
          expires_at: expiresAt.toISOString(),
        })
        .select("id")
        .single();
      redemptionRowId = inserted?.id ?? null;
      pointsToSpend = tier.points_cost;
    }
  }

  // ShopCX joins the internal arm. The Appstle arm below is vendor-specific.
  const { resolveBillingSource } = await import("@/lib/internal-subscription");
  const isInternalLoyalty = (await resolveBillingSource(auth.workspaceId, String(contractId))) !== "appstle";
  if (isInternalLoyalty) {
    // Internal / shopcx sub — apply the loyalty code via the canonical
    // `subscriptionApplyCoupon` path (the same one the Sonnet apply_loyalty_coupon
    // handler uses). It materializes the LOYALTY-* redemption as an internal `coupons`
    // row scoped to the contract-owning customer UUID (ensureInternalLoyaltyCouponRow)
    // and resolves it via resolveCoupon step 1 (internal wins) with that SAME internal
    // customer id — so a freshly minted loyalty code no longer depends on the
    // customer-scoped Shopify lookup that returned coupon_not_found for Michelle (the
    // portal's `auth.loggedInCustomerId` is a Shopify id, which never matched the
    // Shopify customerSelection on an internally-billed sub). It also does NOT burn the
    // code at apply, so the discount survives to the renewal charge. Phase 2.
    const { subscriptionApplyCoupon } = await import("@/lib/subscription-items");
    const r = await subscriptionApplyCoupon(auth.workspaceId, String(contractId), code);
    if (!r.success) {
      // Apply failed: redemption stays 'active' (unspent), code untouched for a retry.
      return jsonErr({ error: "coupon_apply_failed", message: r.error, request_payload: { contractId, code } }, 502);
    }
  } else {
  // Apply coupon to subscription via Appstle (remove existing first — only 1 coupon per subscription)
  try {
    const { healOnTouch } = await import("@/lib/appstle-pricing");
    await healOnTouch(auth.workspaceId, String(contractId));
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    const { applyDiscountWithReplace } = await import("@/lib/appstle-discount");
    let result = await applyDiscountWithReplace(auth.workspaceId, apiKey, String(contractId), code);

    // Self-healing: if Appstle rejects the code, regenerate it in Shopify and retry
    if (!result.success && result.status === 400) {
      try {
        const { shop, accessToken } = await getShopifyCredentials(auth.workspaceId);

        // Check if unused
        const checkRes = await portalFetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query: `{ codeDiscountNodeByCode(code: "${code}") { id codeDiscount { ... on DiscountCodeBasic { asyncUsageCount } } } }` }),
        });
        const checkData = await checkRes.json();
        const oldNodeId = checkData?.data?.codeDiscountNodeByCode?.id;
        const usage = checkData?.data?.codeDiscountNodeByCode?.codeDiscount?.asyncUsageCount || 0;

        if (usage === 0 && oldNodeId) {
          // Delete old coupon
          await portalFetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({ query: `mutation { discountCodeDelete(id: "${oldNodeId}") { deletedCodeDiscountId userErrors { field message } } }` }),
          });

          // Generate new code
          const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          let rand = "";
          for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
          const newCode = `LOYALTY-${discountValue}-${rand}`;

          const customer2 = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
          const fName = customer2?.first_name || "Customer";
          const lInit = customer2?.last_name ? customer2.last_name[0] : "";
          const title = `Loyalty $${discountValue} - ${fName} ${lInit} (${newCode})`.trim();

          const { getLoyaltySettings: getLS } = await import("@/lib/loyalty");
          const ls = await getLS(auth.workspaceId);
          const expAt = new Date();
          expAt.setDate(expAt.getDate() + (ls.coupon_expiry_days || 90));

          // Look up shopify_customer_id
          const { data: custRow } = await admin.from("customers")
            .select("shopify_customer_id")
            .eq("id", customer2?.id || "")
            .single();

          const createRes = await portalFetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
            method: "POST", headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
            body: JSON.stringify({
              query: DISCOUNT_CREATE_MUTATION,
              variables: {
                basicCodeDiscount: {
                  title, code: newCode,
                  startsAt: new Date().toISOString(), endsAt: expAt.toISOString(),
                  usageLimit: 1, appliesOncePerCustomer: true,
                  customerSelection: { customers: { add: [`gid://shopify/Customer/${custRow?.shopify_customer_id}`] } },
                  combinesWith: { productDiscounts: ls.coupon_combines_product ?? false, shippingDiscounts: ls.coupon_combines_shipping ?? true, orderDiscounts: ls.coupon_combines_order ?? false },
                  customerGets: { appliesOnOneTimePurchase: (ls.coupon_applies_to || "both") !== "subscription", appliesOnSubscription: (ls.coupon_applies_to || "both") !== "one_time", items: { all: true }, value: { discountAmount: { amount: discountValue, appliesOnEachItem: false } } },
                },
              },
            }),
          });
          const createData = await createRes.json();
          const newNodeId = createData?.data?.discountCodeBasicCreate?.codeDiscountNode?.id;

          if (newNodeId) {
            // Retry apply with new code
            result = await applyDiscountWithReplace(auth.workspaceId, apiKey, String(contractId), newCode);
            if (result.success) {
              code = newCode;
              shopifyDiscountId = newNodeId;
              // Point the tracked redemption row at the regenerated code.
              if (redemptionRowId) {
                await admin.from("loyalty_redemptions").update({ discount_code: newCode, shopify_discount_id: newNodeId }).eq("id", redemptionRowId);
              }
              console.log(`[loyalty] Self-healed: regenerated ${code} → ${newCode} for contract ${contractId}`);
            }
          }
        }
      } catch (healErr) {
        console.error("[loyalty] Self-healing failed:", healErr);
      }
    }

    if (!result.success) {
      // Apply failed: redemption stays 'active' (unspent), code untouched for a retry.
      return jsonErr({ error: "coupon_apply_failed", message: result.error, request_payload: { contractId, code } }, 502);
    }
  } catch (e) {
    return handleAppstleError(e, { route: "loyaltyApplySubscription", payload: { contractId, code } });
  }
  }

  // ---- Apply succeeded — only now spend points and mark the redemption applied. ----

  // Resolve the member id for the release sweep below.
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  let memberId = member?.id ?? null;
  if (!memberId) {
    const { data: m } = await admin.from("loyalty_members")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_customer_id", auth.loggedInCustomerId)
      .single();
    memberId = m?.id ?? null;
  }

  // Release any PREVIOUSLY applied loyalty coupons back to 'active' — but EXCLUDE the code we
  // just applied, and run this before flipping the current row to 'applied' so we never flip
  // the just-applied redemption straight back to active.
  if (memberId) {
    await admin.from("loyalty_redemptions")
      .update({ status: "active" })
      .eq("workspace_id", auth.workspaceId)
      .eq("member_id", memberId)
      .eq("status", "applied")
      .neq("discount_code", code);
  }

  // Spend points only now that the code is actually on the subscription.
  if (pointsToSpend > 0 && member) {
    await spendPoints(member, pointsToSpend, spendDescription, shopifyDiscountId);
  }

  // Mark the redemption applied (and persist the spend on the row when we just spent).
  if (redemptionRowId) {
    const update: Record<string, unknown> = { status: "applied" };
    if (pointsToSpend > 0) update.points_spent = pointsToSpend;
    await admin.from("loyalty_redemptions")
      .update(update)
      .eq("id", redemptionRowId)
      .eq("workspace_id", auth.workspaceId);
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
