import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// GET: List coupon mappings + optionally sync from Shopify
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const sync = url.searchParams.get("sync") === "true";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // If sync requested, pull discounts from Shopify
  const shopifyDiscounts: { id: string; code: string; title: string; valueType: string; value: number }[] = [];

  if (sync) {
    try {
      const { shop, accessToken } = await getShopifyCredentials(workspaceId);

      // Paginate through all active discount codes
      let hasNextPage = true;
      let cursor: string | null = null;

      while (hasNextPage) {
        const afterArg: string = cursor ? ", after: " + JSON.stringify(cursor) : "";
        const query = [
          "{ codeDiscountNodes(first: 250, query: " + JSON.stringify("status:active") + afterArg + ") {",
          "  nodes { id codeDiscount {",
          "    ... on DiscountCodeBasic { title status usageLimit codes(first: 1) { nodes { code } } customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } } appliesOncePerCustomer }",
          "    ... on DiscountCodeFreeShipping { title status usageLimit codes(first: 1) { nodes { code } } appliesOncePerCustomer }",
          "  } }",
          "  pageInfo { hasNextPage endCursor }",
          "} }",
        ].join("\n");

        const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        });

        const data = await res.json();
        const result = data?.data?.codeDiscountNodes;
        const nodes = result?.nodes || [];
        hasNextPage = result?.pageInfo?.hasNextPage || false;
        cursor = result?.pageInfo?.endCursor || null;

      for (const node of nodes) {
        const d = node.codeDiscount;
        if (!d) continue;

        // Only include active, reusable, non-free codes
        if (d.status !== "ACTIVE") continue;
        if (d.appliesOncePerCustomer) continue; // Skip one-per-customer codes
        // Skip 100% off codes
        if (d.customerGets?.value?.percentage != null && d.customerGets.value.percentage >= 1.0) continue;

        const code = d.codes?.nodes?.[0]?.code || "";
        if (!code) continue;

        const valueObj = d.customerGets?.value;
        let valueType = "percentage";
        let value = 0;
        if (valueObj?.percentage != null) {
          valueType = "percentage";
          value = valueObj.percentage * 100;
        } else if (valueObj?.amount?.amount != null) {
          valueType = "fixed_amount";
          value = parseFloat(valueObj.amount.amount);
        } else {
          valueType = "free_shipping";
          value = 0;
        }

        shopifyDiscounts.push({
          id: node.id,
          code,
          title: d.title || code,
          valueType,
          value,
        });
      }
      } // end while pagination
    } catch (err) {
      console.error("Shopify discount sync error:", err);
    }
  }

  // Get existing mappings
  const { data: mappings } = await admin
    .from("coupon_mappings")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  // Get VIP threshold
  const { data: ws } = await admin
    .from("workspaces")
    .select("vip_retention_threshold, coupon_price_floor_pct")
    .eq("id", workspaceId)
    .single();

  return NextResponse.json({
    mappings: mappings || [],
    shopify_discounts: shopifyDiscounts,
    vip_threshold: ws?.vip_retention_threshold || 85,
    coupon_price_floor_pct: ws?.coupon_price_floor_pct ?? 50,
  });
}

// POST: Create or update a coupon mapping
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { error } = await admin.from("coupon_mappings").upsert({
    workspace_id: workspaceId,
    shopify_discount_id: body.shopify_discount_id,
    code: body.code,
    title: body.title || null,
    value_type: body.value_type,
    value: body.value,
    summary: body.summary || null,
    use_cases: body.use_cases || [],
    customer_tier: body.customer_tier || "all",
    ai_enabled: body.ai_enabled ?? true,
    agent_enabled: body.agent_enabled ?? true,
    applies_to_subscriptions: body.applies_to_subscriptions ?? true,
    max_uses_per_customer: body.max_uses_per_customer || null,
    notes: body.notes || null,
  }, { onConflict: "workspace_id,code" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

// DELETE: Remove a coupon mapping
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const url = new URL(request.url);
  const couponId = url.searchParams.get("id");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  await admin.from("coupon_mappings").delete().eq("id", couponId).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
