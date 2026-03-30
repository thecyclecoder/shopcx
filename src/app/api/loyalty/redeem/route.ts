import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLoyaltySettings,
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

export async function POST(request: Request) {
  // Support both authenticated dashboard users and portal requests
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

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
  const code = generateCode(tier.discount_value);
  const title = `Loyalty $${tier.discount_value} - ${firstName} ${lastInitial}`.trim();

  // Compute expiry date
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + settings.coupon_expiry_days);

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspace_id);

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
              title,
              code,
              startsAt: new Date().toISOString(),
              endsAt: expiresAt.toISOString(),
              usageLimit: 1,
              appliesOncePerCustomer: true,
              customerSelection: {
                customers: {
                  add: [`gid://shopify/Customer/${member.shopify_customer_id}`],
                },
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
                value: {
                  discountAmount: {
                    amount: tier.discount_value,
                    appliesOnEachItem: false,
                  },
                },
              },
            },
          },
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API error: ${res.status} ${text}`);
    }

    const gqlResult = await res.json();
    const userErrors = gqlResult?.data?.discountCodeBasicCreate?.userErrors;
    if (userErrors?.length > 0) {
      return NextResponse.json(
        { error: userErrors.map((e: { message: string }) => e.message).join(", ") },
        { status: 400 },
      );
    }

    const discountNodeId = gqlResult?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;

    // Deduct points
    await spendPoints(member, tier.points_cost, `Redeemed ${tier.label}`, discountNodeId);

    // Record redemption
    await admin.from("loyalty_redemptions").insert({
      workspace_id,
      member_id: member.id,
      reward_tier: tier.label,
      points_spent: tier.points_cost,
      discount_code: code,
      shopify_discount_id: discountNodeId,
      discount_value: tier.discount_value,
      status: "active",
      expires_at: expiresAt.toISOString(),
    });

    return NextResponse.json({
      ok: true,
      code,
      discount_value: tier.discount_value,
      expires_at: expiresAt.toISOString(),
      new_balance: member.points_balance - tier.points_cost,
    });
  } catch (err) {
    console.error("Loyalty redemption failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Redemption failed" },
      { status: 500 },
    );
  }
}
