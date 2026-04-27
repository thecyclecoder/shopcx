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
              metafields(keys: ["reviews.rating", "reviews.rating_count"], first: 2) {
                edges { node { key value } }
              }
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

      const variants: Array<{ id: string | undefined; position: number; title: string; sku: string; price_cents: number; image_url: string | null }> =
        (p.variants?.edges || []).map((v: { node: { id: string; title: string; sku: string; price: string; image?: { url?: string } } }, position: number) => ({
          id: v.node.id.split("/").pop(),
          position,
          title: v.node.title,
          sku: v.node.sku,
          price_cents: Math.round(parseFloat(v.node.price || "0") * 100),
          image_url: v.node.image?.url || null,
        }));

      const imageUrl = p.images?.edges?.[0]?.node?.url || null;

      // Extract rating from metafields
      const metafields = (p.metafields?.edges || []).map((e: { node: { key: string; value: string } }) => e.node);
      const ratingMeta = metafields.find((m: { key: string }) => m.key === "reviews.rating");
      const ratingCountMeta = metafields.find((m: { key: string }) => m.key === "reviews.rating_count");
      // Rating metafield value is JSON: {"value": "4.74", "scale_min": "1.0", "scale_max": "5.0"}
      let ratingValue: number | null = null;
      if (ratingMeta?.value) {
        try {
          const parsed = JSON.parse(ratingMeta.value);
          ratingValue = parseFloat(parsed.value || parsed) || null;
        } catch {
          ratingValue = parseFloat(ratingMeta.value) || null;
        }
      }
      const ratingCount = ratingCountMeta?.value ? parseInt(ratingCountMeta.value) || null : null;

      // Upsert the product row first so we have its UUID for the variants table
      const { data: productRow } = await admin.from("products").upsert({
        workspace_id: workspaceId,
        shopify_product_id: shopifyId,
        title: p.title,
        handle: p.handle,
        product_type: p.productType || null,
        vendor: p.vendor || null,
        status: (p.status || "active").toLowerCase(),
        tags: p.tags || [],
        image_url: imageUrl,
        variants, // legacy mirror — internal_id stamped after variant upsert
        rating: ratingValue,
        rating_count: ratingCount,
        updated_at: new Date().toISOString(),
      }, { onConflict: "workspace_id,shopify_product_id" })
        .select("id")
        .single();

      // Mirror variants to the first-class table. Each gets a stable UUID;
      // shopify_variant_id is the upsert match key. Then stamp internal_id
      // back into the JSONB mirror so legacy readers see the UUID.
      if (productRow?.id && variants.length) {
        const internalIdByShopifyId: Record<string, string> = {};
        for (const v of variants) {
          if (!v.id) continue;
          const { data: vrow } = await admin.from("product_variants").upsert({
            workspace_id: workspaceId,
            product_id: productRow.id,
            shopify_variant_id: v.id,
            sku: v.sku ?? null,
            title: v.title ?? null,
            price_cents: v.price_cents ?? 0,
            image_url: v.image_url ?? null,
            position: v.position ?? 0,
            updated_at: new Date().toISOString(),
          }, { onConflict: "workspace_id,shopify_variant_id" })
            .select("id")
            .single();
          if (vrow?.id) internalIdByShopifyId[v.id] = vrow.id;
        }
        if (Object.keys(internalIdByShopifyId).length) {
          const stamped = variants.map(v => v.id && internalIdByShopifyId[v.id]
            ? { ...v, internal_id: internalIdByShopifyId[v.id] }
            : v);
          await admin.from("products").update({ variants: stamped }).eq("id", productRow.id);
        }
      }

      synced++;
    }

    return NextResponse.json({ synced, channel: "Online Store" });
  } catch (err) {
    console.error("Product sync error:", err);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
