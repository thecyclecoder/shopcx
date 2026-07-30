/**
 * Probe: list every variant with an isolated (cut-out) product shot, grouped by product.
 * Read-only. For picking packshots for a VIP-sale graphic.
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("product_variants")
    .select(
      "id, product_id, title, sku, isolated_image_url, position, available, products!product_variants_product_id_fkey(title, handle)",
    )
    .not("isolated_image_url", "is", null)
    .order("position", { ascending: true });

  if (error) throw error;

  const rows = (data || []) as any[];
  console.log(`variants with isolated_image_url: ${rows.length}\n`);

  const byProduct = new Map<string, any[]>();
  for (const r of rows) {
    const key = r.products?.title || r.product_id;
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(r);
  }

  for (const [product, vs] of [...byProduct.entries()].sort()) {
    console.log(`\n=== ${product} (${vs.length}) ===`);
    for (const v of vs) {
      console.log(`  [${v.available ? "live" : "OFF "}] ${v.title || v.sku || v.id}`);
      console.log(`        ${v.isolated_image_url}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
