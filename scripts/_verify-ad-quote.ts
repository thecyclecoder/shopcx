/**
 * Is the "Michael / lost roughly 50 pounds in 18 months" testimonial a REAL review,
 * and is it a review of the product being advertised (Amazing Coffee K-Cups)?
 * The quote + reviewer name must be real and self-consistent (CEO rule). READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";

async function main() {
  const a = createAdminClient();
  const { data: prod } = await a.from("products").select("id,title,shopify_product_id").eq("id", KCUPS).maybeSingle();
  console.log(`advertised product: ${prod?.title}  shopify_product_id=${prod?.shopify_product_id}`);

  const { data: allProds } = await a.from("products").select("shopify_product_id,title").eq("workspace_id", WS);
  const titleByShopId = new Map((allProds ?? []).map((p) => [String(p.shopify_product_id), String(p.title)]));

  for (const needle of ["50 pounds", "18 months", "weight"]) {
    const { data, error } = await a.from("product_reviews")
      .select("id,shopify_product_id,reviewer_name,rating,title,body,created_at,verified_purchase,product_name")
      .eq("workspace_id", WS).ilike("body", `%${needle}%`).limit(8);
    if (error) throw new Error(`product_reviews(${needle}): ${error.message}`);
    console.log(`\n=== reviews whose body contains "${needle}": ${(data ?? []).length} ===`);
    for (const r of data ?? []) {
      const onKcups = String(r.shopify_product_id) === String(prod?.shopify_product_id);
      const which = titleByShopId.get(String(r.shopify_product_id)) ?? r.product_name ?? "?";
      console.log(`  ${String(r.reviewer_name ?? "?").padEnd(24)} ${r.rating}★ ${String(r.created_at).slice(0, 10)} verified=${r.verified_purchase}  ${onKcups ? "★ K-CUPS" : `[${String(which).slice(0, 26)}]`}`);
      console.log(`     ${String(r.body ?? "").replace(/\s+/g, " ").slice(0, 230)}`);
    }
  }

  const { data: michael, error: me } = await a.from("product_reviews")
    .select("shopify_product_id,reviewer_name,rating,body,created_at,verified_purchase")
    .eq("workspace_id", WS).ilike("reviewer_name", "%michael%").limit(10);
  if (me) throw new Error(`michael: ${me.message}`);
  console.log(`\n=== reviewers named Michael: ${(michael ?? []).length} ===`);
  for (const r of michael ?? []) {
    console.log(`  ${r.reviewer_name} ${r.rating}★ ${titleByShopId.get(String(r.shopify_product_id)) ?? "?"} ${String(r.created_at).slice(0, 10)}`);
    console.log(`     ${String(r.body ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
  }

  const { count } = await a.from("product_reviews").select("id", { count: "exact", head: true })
    .eq("workspace_id", WS).eq("shopify_product_id", String(prod?.shopify_product_id));
  console.log(`\ntotal reviews ON Amazing Coffee K-Cups: ${count}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
