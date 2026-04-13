/**
 * Hourly inventory sync — fetches inventory levels from Shopify and updates
 * the variants JSONB on each product with inventory_quantity.
 * Sonnet uses this to know what's in/out of stock (<10 = out of stock).
 */

import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

interface VariantNode {
  id: string;
  inventoryQuantity: number;
}

interface MetafieldNode {
  key: string;
  value: string;
}

interface ProductNode {
  id: string;
  variants: { nodes: VariantNode[] };
  metafields?: { nodes: MetafieldNode[] };
}

async function fetchInventory(shop: string, accessToken: string): Promise<ProductNode[]> {
  const all: ProductNode[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 20; page++) {
    const afterClause: string = cursor ? `, after: "${cursor}"` : "";
    const query: string = `{
      products(first: 50${afterClause}) {
        edges {
          cursor
          node {
            id
            variants(first: 100) {
              nodes { id inventoryQuantity }
            }
            metafields(keys: ["reviews.rating", "reviews.rating_count"], first: 2) {
              nodes { key value }
            }
          }
        }
        pageInfo { hasNextPage }
      }
    }`;

    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      },
    );

    if (!res.ok) break;
    const data = await res.json();
    const edges = data?.data?.products?.edges || [];
    for (const edge of edges) {
      all.push(edge.node);
      cursor = edge.cursor;
    }
    if (!data?.data?.products?.pageInfo?.hasNextPage) break;
  }

  return all;
}

function extractId(gid: string): string {
  return String(gid).split("/").pop() || String(gid);
}

export const syncInventory = inngest.createFunction(
  {
    id: "sync-inventory",
    retries: 2,
    triggers: [{ cron: "0 * * * *" }], // Every hour
  },
  async ({ step }) => {
    const admin = createAdminClient();

    // Get all workspaces with Shopify connected
    const workspaces = await step.run("get-workspaces", async () => {
      const { data } = await admin.from("workspaces")
        .select("id")
        .not("shopify_access_token_encrypted", "is", null)
        .not("shopify_myshopify_domain", "is", null);
      return data || [];
    });

    let totalUpdated = 0;

    for (const ws of workspaces) {
      await step.run(`sync-${ws.id.slice(0, 8)}`, async () => {
        const { shop, accessToken } = await getShopifyCredentials(ws.id);
        const products = await fetchInventory(shop, accessToken);

        for (const product of products) {
          const shopifyProductId = extractId(product.id);
          const inventoryMap = new Map<string, number>();
          for (const v of product.variants.nodes) {
            inventoryMap.set(extractId(v.id), v.inventoryQuantity);
          }

          // Get our product record
          const { data: dbProduct } = await admin.from("products")
            .select("id, variants")
            .eq("workspace_id", ws.id)
            .eq("shopify_product_id", shopifyProductId)
            .single();

          if (!dbProduct) continue;

          // Update each variant with inventory_quantity
          const variants = (dbProduct.variants as { id?: string }[]) || [];
          let changed = false;
          const updated = variants.map(v => {
            const qty = inventoryMap.get(String(v.id));
            if (qty !== undefined && (v as Record<string, unknown>).inventory_quantity !== qty) {
              changed = true;
              return { ...v, inventory_quantity: qty };
            }
            return v;
          });

          // Extract rating from metafields
          const metafields = product.metafields?.nodes || [];
          const ratingMeta = metafields.find(m => m.key === "reviews.rating");
          const ratingCountMeta = metafields.find(m => m.key === "reviews.rating_count");
          let ratingValue: number | null = null;
          if (ratingMeta?.value) {
            try { const p = JSON.parse(ratingMeta.value); ratingValue = parseFloat(p.value || p) || null; }
            catch { ratingValue = parseFloat(ratingMeta.value) || null; }
          }
          const ratingCount = ratingCountMeta?.value ? parseInt(ratingCountMeta.value) || null : null;

          const updatePayload: Record<string, unknown> = {};
          if (changed) {
            updatePayload.variants = updated;
            updatePayload.inventory_updated_at = new Date().toISOString();
          }
          if (ratingValue !== null) updatePayload.rating = ratingValue;
          if (ratingCount !== null) updatePayload.rating_count = ratingCount;

          if (Object.keys(updatePayload).length > 0) {
            await admin.from("products").update(updatePayload).eq("id", dbProduct.id);
            if (changed) totalUpdated++;
          }
        }
      });
    }

    return { workspaces: workspaces.length, productsUpdated: totalUpdated };
  },
);
