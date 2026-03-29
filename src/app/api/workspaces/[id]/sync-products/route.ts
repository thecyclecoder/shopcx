import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// POST: Sync products from Shopify Online Store channel
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    // Find the Online Store publication
    const pubRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ publications(first: 10) { edges { node { id name } } } }` }),
    });
    const pubJson = await pubRes.json();
    const onlineStore = pubJson.data?.publications?.edges?.find(
      (e: { node: { name: string } }) => e.node.name === "Online Store"
    );

    if (!onlineStore) {
      return NextResponse.json({ error: "Online Store publication not found" }, { status: 404 });
    }

    // Get products published on Online Store with full details
    const prodQuery = `{
      publication(id: "${onlineStore.node.id}") {
        products(first: 100) {
          edges {
            node {
              id title handle productType vendor status tags
              images(first: 1) { edges { node { url } } }
              variants(first: 20) {
                edges { node { id title sku price image { url } } }
              }
            }
          }
        }
      }
    }`;

    const prodRes = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query: prodQuery }),
    });
    const prodJson = await prodRes.json();
    const products = prodJson.data?.publication?.products?.edges || [];

    // Deduplicate by shopify_product_id (Shipping Protection appears multiple times)
    const seen = new Set<string>();
    let synced = 0;

    for (const edge of products) {
      const p = edge.node;
      const shopifyId = p.id.split("/").pop();
      if (seen.has(shopifyId)) continue;
      seen.add(shopifyId);

      const variants = (p.variants?.edges || []).map((v: { node: { id: string; title: string; sku: string; price: string; image?: { url?: string } } }) => ({
        id: v.node.id.split("/").pop(),
        title: v.node.title,
        sku: v.node.sku,
        price_cents: Math.round(parseFloat(v.node.price || "0") * 100),
        image_url: v.node.image?.url || null,
      }));

      const imageUrl = p.images?.edges?.[0]?.node?.url || null;

      await admin.from("products").upsert({
        workspace_id: workspaceId,
        shopify_product_id: shopifyId,
        title: p.title,
        handle: p.handle,
        product_type: p.productType || null,
        vendor: p.vendor || null,
        status: (p.status || "active").toLowerCase(),
        tags: p.tags || [],
        image_url: imageUrl,
        variants,
        updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id,shopify_product_id" });

      synced++;
    }

    return NextResponse.json({ synced, channel: "Online Store" });
  } catch (err) {
    console.error("Product sync error:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
