/**
 * Pulls the current Shopify catalog (Online Store publication) and
 * stamps `products.shopify_category`, `products.shopify_category_id`,
 * `products.taxable`, `products.avalara_tax_code`, plus per-variant
 * `taxable` + `shopify_tax_code` on `product_variants`.
 *
 * Same logic as POST /api/workspaces/:id/sync-products but standalone
 * so we can backfill without re-running the heavier full sync.
 *
 * Manual avalara_tax_code overrides are preserved — we only stamp
 * the classifier's output on rows where avalara_tax_code is NULL.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";
import { classifyByShopifyCategory } from "../src/lib/avalara-tax-codes";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const API_VERSION = "2024-07";

async function main() {
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", WS).single();
  if (!ws?.shopify_access_token_encrypted) throw new Error("Shopify not connected");
  const shop = ws.shopify_myshopify_domain;
  const token = decrypt(ws.shopify_access_token_encrypted);

  const pubRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ publications(first: 10) { edges { node { id name } } } }` }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubData = (await pubRes.json()) as any;
  const onlineStoreId = pubData.data?.publications?.edges?.find((e: { node: { name: string } }) => e.node.name === "Online Store")?.node.id;
  if (!onlineStoreId) throw new Error("Online Store publication not found");

  const query = `{
    publication(id: "${onlineStoreId}") {
      products(first: 100) {
        edges {
          node {
            id title
            category { id fullName }
            variants(first: 20) {
              edges { node { id taxable taxCode } }
            }
          }
        }
      }
    }
  }`;
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any;
  if (data.errors) {
    console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
    process.exit(1);
  }
  const products = data.data?.publication?.products?.edges || [];
  console.log(`Fetched ${products.length} products from Shopify`);

  const seen = new Set<string>();
  let updated = 0;
  let preserved = 0;
  let variantsUpdated = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const edge of products) {
    const p = edge.node;
    const shopifyId = p.id.split("/").pop();
    if (seen.has(shopifyId)) continue;
    seen.add(shopifyId);

    const shopifyCategory: string | null = p.category?.fullName || null;
    const shopifyCategoryId: string | null = p.category?.id || null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const variantNodes = (p.variants?.edges || []).map((e: any) => e.node);
    const productTaxable = variantNodes.length === 0 ? true : variantNodes.some((v: { taxable?: boolean }) => v.taxable !== false);

    const classification = classifyByShopifyCategory(shopifyCategory, p.title);

    const { data: existing } = await admin
      .from("products")
      .select("id, avalara_tax_code")
      .eq("workspace_id", WS)
      .eq("shopify_product_id", shopifyId)
      .maybeSingle();
    if (!existing) {
      console.log(`  ! product ${shopifyId} (${p.title}) not in our DB yet — skipping`);
      continue;
    }

    const hadManualCode = existing.avalara_tax_code != null;
    const nextCode = hadManualCode ? existing.avalara_tax_code : classification.taxCode;
    if (hadManualCode && existing.avalara_tax_code !== classification.taxCode) preserved++;

    const { error } = await admin
      .from("products")
      .update({
        shopify_category: shopifyCategory,
        shopify_category_id: shopifyCategoryId,
        taxable: productTaxable,
        avalara_tax_code: nextCode,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) { console.error(`  ! update failed for ${p.title}:`, error.message); continue; }

    console.log(
      `  ✓ ${p.title.padEnd(30)}  cat: ${(shopifyCategory || "(none)").slice(0, 60).padEnd(60)}  code: ${(nextCode || "—").padEnd(10)}  bucket: ${classification.bucket}${hadManualCode ? "  [manual override preserved]" : ""}`,
    );
    updated++;

    for (const v of variantNodes) {
      const variantShopifyId = v.id.split("/").pop();
      const { error: vErr } = await admin
        .from("product_variants")
        .update({
          taxable: v.taxable !== false,
          shopify_tax_code: v.taxCode || null,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", WS)
        .eq("shopify_variant_id", variantShopifyId);
      if (!vErr) variantsUpdated++;
    }
  }

  console.log(`\nDone — ${updated} products updated, ${variantsUpdated} variants updated, ${preserved} manual codes preserved.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
