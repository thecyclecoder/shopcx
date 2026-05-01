/**
 * Backfill product_variants.servings + servings_unit from each
 * product's Shopify metafields (custom.servings, custom.servings_unit).
 *
 * Run: npx tsx scripts/backfill-variant-servings.ts
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

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { getShopifyCredentials } = await import("../src/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("../src/lib/shopify");
  const admin = createAdminClient();

  const { data: workspaces } = await admin.from("workspaces")
    .select("id, name").not("shopify_access_token_encrypted", "is", null);

  for (const ws of workspaces || []) {
    console.log(`\n══ ${ws.name} (${ws.id}) ══`);

    let shop: string, accessToken: string;
    try {
      ({ shop, accessToken } = await getShopifyCredentials(ws.id));
    } catch (err) {
      console.log(`  skip: no Shopify creds (${err instanceof Error ? err.message : "unknown"})`);
      continue;
    }

    const { data: products } = await admin.from("products")
      .select("id, title, shopify_product_id")
      .eq("workspace_id", ws.id)
      .not("shopify_product_id", "is", null);

    let updatedProducts = 0;
    let updatedVariants = 0;

    for (const p of products || []) {
      const query = `{
        product(id: "gid://shopify/Product/${p.shopify_product_id}") {
          servings: metafield(namespace: "custom", key: "servings") { value }
          unit: metafield(namespace: "custom", key: "servings_unit") { value }
        }
      }`;
      const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const j = await res.json();
      if (j.errors) { console.log(`  ${p.title}: errors`, JSON.stringify(j.errors).slice(0, 200)); continue; }

      const servingsRaw = j.data?.product?.servings?.value;
      const servingsUnit = j.data?.product?.unit?.value || null;
      const servings = servingsRaw ? parseInt(servingsRaw, 10) : null;

      if (servings == null) {
        console.log(`  ${p.title}: no servings metafield, skip`);
        continue;
      }

      const { error, count } = await admin.from("product_variants")
        .update({
          servings,
          servings_unit: servingsUnit,
          updated_at: new Date().toISOString(),
        }, { count: "exact" })
        .eq("workspace_id", ws.id)
        .eq("product_id", p.id);

      if (error) {
        console.log(`  ${p.title}: update error`, error.message);
        continue;
      }
      updatedProducts++;
      updatedVariants += count || 0;
      console.log(`  ${p.title}: ${servings} ${servingsUnit || "Servings"} → ${count} variants`);
    }

    console.log(`  Done: ${updatedProducts} products, ${updatedVariants} variants updated`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
