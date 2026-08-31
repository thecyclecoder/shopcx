import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLoyaltySettings,
  getRedemptionTiers,
  validateRedemption,
  spendPoints,
} from "@/lib/loyalty";
import { createCustomerDiscount } from "@/lib/coupons";

export async function POST(request: Request) {
  // Support both authenticated dashboard users and portal requests
  const { user } = await getAuthedUser();
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { workspace_id, shopify_customer_id, member_id, tier_index } = body as {
    workspace_id?: string;
    shopify_customer_id?: string;
    member_id?: string;
    tier_index?: number;
  };

  if (!workspace_id || (!shopify_customer_id && !member_id) || tier_index == null) {
    return NextResponse.json({ error: "workspace_id, (shopify_customer_id or member_id), tier_index required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // If dashboard user, verify membership
  if (user) {
    const { data: wsm } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", user.id)
      .single();
    if (!wsm) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Get settings
  const settings = await getLoyaltySettings(workspace_id);
  if (!settings.enabled) {
    return NextResponse.json({ error: "Loyalty system is disabled" }, { status: 400 });
  }

  const tiers = getRedemptionTiers(settings);
  if (tier_index < 0 || tier_index >= tiers.length) {
    return NextResponse.json({ error: "Invalid tier index" }, { status: 400 });
  }
  const tier = tiers[tier_index];

  // Get member by ID or shopify_customer_id
  let memberQuery = admin.from("loyalty_members").select("*").eq("workspace_id", workspace_id);
  if (member_id) {
    memberQuery = memberQuery.eq("id", member_id);
  } else {
    memberQuery = memberQuery.eq("shopify_customer_id", shopify_customer_id!);
  }
  const { data: member } = await memberQuery.single();

  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Validate
  const validation = validateRedemption(member, tier);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Get customer name for discount title
  const { data: customer } = await admin
    .from("customers")
    .select("first_name, last_name")
    .eq("id", member.customer_id)
    .single();

  const firstName = customer?.first_name || "Customer";
  const lastInitial = customer?.last_name ? customer.last_name[0] : "";

  // Delegate to the shared chokepoint. It resolves linked shopify customer ids
  // internally (via getLinkedShopifyCustomerIds), builds the same
  // customerSelection + combinesWith + customerGets payload the inline path
  // used, and falls back to the internal mintCustomerCoupon if the linked
  // group has no shopify_customer_id — behavior-preserving refactor per
  // docs/brain/specs/review-collection-foundations.md Phase 2 (the loyalty
  // route was the "one hand-rolled copy" the chokepoint rule forbids).
  const disc = await createCustomerDiscount(workspace_id, member.customer_id, {
    amount: tier.discount_value,
    codePrefix: "LOYALTY",
    expiryDays: settings.coupon_expiry_days,
    title: `Loyalty $${tier.discount_value} - ${firstName} ${lastInitial}`.trim(),
    appliesOnOneTimePurchase: settings.coupon_applies_to !== "subscription",
    appliesOnSubscription: settings.coupon_applies_to !== "one_time",
    combinesWith: {
      productDiscounts: settings.coupon_combines_product,
      shippingDiscounts: settings.coupon_combines_shipping,
      orderDiscounts: settings.coupon_combines_order,
    },
    // Preserve the pre-refactor edge case where the member row carries a
    // shopify_customer_id but member.customer_id doesn't (yet) map through
    // getLinkedShopifyCustomerIds — include it explicitly so nothing drops.
    additionalShopifyCustomerIds: member.shopify_customer_id
      ? [String(member.shopify_customer_id)]
      : [],
  });

  if (!disc) {
    return NextResponse.json({ error: "Failed to mint discount" }, { status: 500 });
  }

  // Compute expiry date for the loyalty_redemptions ledger
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.coupon_expiry_days);

  // `source: 'internal'` means createCustomerDiscount found no Shopify customer
  // id anywhere in the linked group and fell back to mintCustomerCoupon. That
  // code is real and the points are genuinely spent — but it resolves ONLY on
  // the in-house storefront (src/lib/coupons.ts resolveCoupon), NOT at Shopify
  // checkout, which is still where most traffic goes. Pre-refactor this path
  // threw and the member kept their points; silently spending them on a code
  // that fails at the register they actually use is the worse trade. Surface it
  // on the response so the portal can say where the code works, and warn so it
  // is visible in logs rather than only as a null shopify_discount_id.
  if (disc.source === "internal") {
    console.warn(
      `[loyalty] internal-coupon fallback for member=${member.id} customer=${member.customer_id} ` +
        `code=${disc.code} — no linked shopify_customer_id; this code redeems on the in-house ` +
        `storefront only, not at Shopify checkout.`,
    );
  }

  // spendPoints + the ledger insert are wrapped: a throw between them leaves a
  // minted Shopify discount with no loyalty_redemptions row (or spent points
  // with no record). Pre-refactor both sat inside the route's try/catch; the
  // extraction dropped that, so restore it rather than surface an unhandled 500.
  try {
    // Deduct points
    await spendPoints(member, tier.points_cost, `Redeemed ${tier.label}`, disc.shopifyDiscountNodeId);

    // Record redemption
    const { error: ledgerError } = await admin.from("loyalty_redemptions").insert({
      workspace_id,
      member_id: member.id,
      reward_tier: tier.label,
      points_spent: tier.points_cost,
      discount_code: disc.code,
      shopify_discount_id: disc.shopifyDiscountNodeId,
      discount_value: tier.discount_value,
      status: "active",
      expires_at: expiresAt.toISOString(),
    });
    if (ledgerError) {
      // The discount exists and the points are spent — a missing ledger row is
      // a reconciliation problem, not a reason to fail the member's redemption.
      console.error(
        `[loyalty] redemption ledger insert failed for member=${member.id} code=${disc.code}: ${ledgerError.message}`,
      );
    }
  } catch (err) {
    console.error(
      `[loyalty] post-mint bookkeeping failed for member=${member.id} code=${disc.code}:`,
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json(
      { error: "Redemption could not be completed. Support has been notified." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    code: disc.code,
    discount_value: tier.discount_value,
    expires_at: expiresAt.toISOString(),
    new_balance: member.points_balance - tier.points_cost,
    // 'shopify' → redeemable at Shopify checkout AND the in-house storefront
    // (resolveCoupon's real-time Shopify lookup). 'internal' → in-house
    // storefront ONLY. The portal needs this to tell the member where their
    // code works; without it an internal-fallback code looks identical to a
    // Shopify one right up until it is rejected at checkout.
    source: disc.source,
  });
}
