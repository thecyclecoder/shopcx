/**
 * buildAvalaraLines prefers variant.shopify_tax_code OVER product.avalara_tax_code.
 * If any variant carries a stale code, it silently overrides today's correction. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data: vs, error } = await a.from("product_variants")
    .select("id,title,product_id,shopify_tax_code,taxable").eq("workspace_id", WS);
  if (error) throw new Error(`product_variants: ${error.message}`);

  const withCode = (vs ?? []).filter((v) => v.shopify_tax_code);
  console.log(`variants: ${(vs ?? []).length}  ·  carrying a shopify_tax_code: ${withCode.length}`);

  const { data: prods } = await a.from("products").select("id,title,avalara_tax_code").eq("workspace_id", WS);
  const byId = new Map((prods ?? []).map((p) => [String(p.id), p]));
  for (const v of withCode) {
    const p = byId.get(String(v.product_id));
    const wins = String(v.shopify_tax_code) !== String(p?.avalara_tax_code);
    console.log(`   ${String(p?.title ?? "?").padEnd(28)} ${String(v.title).padEnd(20)} variant=${v.shopify_tax_code}  product=${p?.avalara_tax_code}${wins ? "   ← VARIANT OVERRIDES" : ""}`);
  }

  const notTaxable = (vs ?? []).filter((v) => v.taxable === false);
  console.log(`\nvariants flagged taxable=false: ${notTaxable.length}`);
  if (!withCode.length) console.log(`\n✅ no variant-level override — products.avalara_tax_code is what ships to Avalara.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
