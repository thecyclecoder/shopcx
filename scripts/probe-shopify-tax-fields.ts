/**
 * Probe Shopify GraphQL for whatever tax-classification fields it
 * exposes on our products + variants. We're trying to find the
 * mapping back to Avalara tax codes (PF050144 = supplements,
 * P0000000 = generic merchandise, OS = shipping insurance, etc.).
 *
 * Possible homes for a tax code in Shopify:
 *   - Product.category (Shopify Standard Product Taxonomy)
 *   - Product.productCategory (deprecated mirror of category)
 *   - ProductVariant.taxCode  (Shopify Plus + Avalara/Vertex)
 *   - ProductVariant.taxable
 *   - custom metafields (namespace='avalara' or 'tax')
 *
 * We just print whatever's populated so we can pick which field
 * carries our codes today.
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

  // 1. Find Online Store publication so we only probe live products
  const pubRes = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `{ publications(first: 10) { edges { node { id name } } } }` }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubData = (await pubRes.json()) as any;
  const onlineStoreId = pubData.data?.publications?.edges?.find((e: { node: { name: string } }) => e.node.name === "Online Store")?.node.id;
  if (!onlineStoreId) throw new Error("Online Store publication not found");

  // 2. Pull each product with every tax-ish field we can think of
  const query = `{
    publication(id: "${onlineStoreId}") {
      products(first: 100) {
        edges {
          node {
            id
            title
            handle
            productType
            vendor
            category { id name fullName }
            variants(first: 20) {
              edges {
                node {
                  id
                  title
                  sku
                  taxCode
                  taxable
                  inventoryItem {
                    id
                    countryCodeOfOrigin
                    harmonizedSystemCode
                  }
                }
              }
            }
            metafields(first: 30) {
              edges {
                node { namespace key value type }
              }
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
    console.log("GraphQL errors:", JSON.stringify(data.errors, null, 2));
  }
  const products = data.data?.publication?.products?.edges || [];

  const summary: Array<{
    title: string;
    productType: string | null;
    category: string | null;
    variantCount: number;
    taxCodes: string[];
    taxableFalse: number;
    hsCodes: string[];
    taxMetafields: Array<{ namespace: string; key: string; value: string }>;
  }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const edge of products) {
    const p = edge.node;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const variants = (p.variants?.edges || []).map((e: any) => e.node);
    const taxCodes = [...new Set(variants.map((v: { taxCode?: string }) => v.taxCode).filter(Boolean))] as string[];
    const taxableFalse = variants.filter((v: { taxable?: boolean }) => v.taxable === false).length;
    const hsCodes = [...new Set(variants.map((v: { inventoryItem?: { harmonizedSystemCode?: string } }) => v.inventoryItem?.harmonizedSystemCode).filter(Boolean))] as string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const taxMetafields = (p.metafields?.edges || [])
      .map((e: any) => e.node)
      .filter((m: { namespace: string; key: string }) =>
        /tax|avalara|avatax/i.test(m.namespace) || /tax|avalara|avatax/i.test(m.key)
      );

    summary.push({
      title: p.title,
      productType: p.productType || null,
      category: p.category?.fullName || p.category?.name || null,
      variantCount: variants.length,
      taxCodes,
      taxableFalse,
      hsCodes,
      taxMetafields,
    });
  }

  // Print a compact report
  console.log(`\n--- Tax-field probe across ${summary.length} live products ---\n`);
  for (const s of summary) {
    const codes = s.taxCodes.length ? s.taxCodes.join(", ") : "(none)";
    const cat = s.category || "(no category)";
    const pt = s.productType || "(no productType)";
    const hs = s.hsCodes.length ? ` · HS: ${s.hsCodes.join(",")}` : "";
    const nonTax = s.taxableFalse ? ` · ${s.taxableFalse} variant(s) marked taxable=false` : "";
    const mf = s.taxMetafields.length ? ` · MFs: ${s.taxMetafields.map(m => `${m.namespace}.${m.key}=${m.value}`).join(" | ")}` : "";
    console.log(`• ${s.title}`);
    console.log(`    productType: ${pt}`);
    console.log(`    category   : ${cat}`);
    console.log(`    taxCode    : ${codes}${hs}${nonTax}${mf}`);
  }

  // Distinct value tables
  const allTaxCodes = new Set<string>();
  const allTypes = new Set<string>();
  const allCategories = new Set<string>();
  for (const s of summary) {
    for (const c of s.taxCodes) allTaxCodes.add(c);
    if (s.productType) allTypes.add(s.productType);
    if (s.category) allCategories.add(s.category);
  }
  console.log(`\nDistinct taxCode values on variants: ${[...allTaxCodes].join(", ") || "(NONE — Shopify has no taxCode set)"}`);
  console.log(`Distinct productType values         : ${[...allTypes].join(" | ")}`);
  console.log(`Distinct category names             : ${[...allCategories].join(" | ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
