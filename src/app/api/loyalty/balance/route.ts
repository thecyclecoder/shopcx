import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getLoyaltySettings,
  getRedemptionTiers,
  pointsToDollarValue,
} from "@/lib/loyalty";

/**
 * GET /api/loyalty/balance?shopify_customer_id=123&shop=store.myshopify.com
 *
 * Public endpoint for checkout extension. Resolves workspace from shop domain.
 * Returns points balance, available tiers, and dollar value.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const shopifyCustomerId = searchParams.get("shopify_customer_id");
  const shopDomain = searchParams.get("shop");

  if (!shopifyCustomerId || !shopDomain) {
    return NextResponse.json({ error: "shopify_customer_id and shop required" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Resolve workspace from shop domain
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("shopify_myshopify_domain", shopDomain)
    .single();

  if (!workspace) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const settings = await getLoyaltySettings(workspace.id);
  if (!settings.enabled) {
    return NextResponse.json({ points_balance: 0, tiers: [], dollar_value: 0, enabled: false });
  }

  const { data: member } = await admin
    .from("loyalty_members")
    .select("points_balance")
    .eq("workspace_id", workspace.id)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();

  if (!member) {
    return NextResponse.json({ points_balance: 0, tiers: [], dollar_value: 0, enabled: true });
  }

  const tiers = getRedemptionTiers(settings).map((t, idx) => ({
    ...t,
    tier_index: idx,
    affordable: member.points_balance >= t.points_cost,
    points_needed: Math.max(0, t.points_cost - member.points_balance),
  }));

  return NextResponse.json({
    points_balance: member.points_balance,
    tiers,
    dollar_value: pointsToDollarValue(member.points_balance, settings),
    enabled: true,
    workspace_id: workspace.id,
  });
}
