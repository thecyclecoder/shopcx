/**
 * Read-only probe — surface the five ids Phase 4 of offer-creator needs to
 * fill in `scripts/wire-starter-kit-offer.ts`. Prints:
 *
 *   1. Workspaces (name + id) — pick the Superfoods one.
 *   2. Per-workspace products (title + handle + id, sorted by title) —
 *      pick the PRIMARY product whose bundle PDP renders the Starter Kit.
 *   3. Per-workspace product_variants matching "frother" or "mug" in
 *      title / sku — candidate physical includes.
 *   4. Per-workspace digital_goods with type='downloadable' — candidate
 *      e-guide include.
 *
 * Every read goes through service-role Supabase; NO mutations. Same
 * pattern as scripts/_verify-*-schema.ts. Run:
 *
 *   npx tsx scripts/_probe-starter-kit-refs.ts
 */
import { createAdminClient } from "./_bootstrap";

async function main() {
  const admin = createAdminClient();

  console.log("── Workspaces ──────────────────────────────────────────────");
  const { data: workspaces, error: wsErr } = await admin
    .from("workspaces")
    .select("id, name, storefront_slug")
    .order("name", { ascending: true });
  if (wsErr) throw new Error(`workspaces read failed: ${wsErr.message}`);
  for (const ws of workspaces || []) {
    console.log(`  ${ws.id}  ${ws.name}  (storefront_slug=${ws.storefront_slug ?? "-"})`);
  }
  console.log("");

  for (const ws of workspaces || []) {
    console.log(`── Workspace: ${ws.name} (${ws.id}) ────────────────────`);

    // Products
    const { data: products } = await admin
      .from("products")
      .select("id, handle, title, bundle_variant_id, bundle_coupon_code")
      .eq("workspace_id", ws.id)
      .eq("status", "active")
      .order("title", { ascending: true });
    console.log(`  Products (${(products || []).length}):`);
    for (const p of products || []) {
      const stamped =
        p.bundle_variant_id || p.bundle_coupon_code
          ? `  [stamped: bundle_variant_id=${p.bundle_variant_id ?? "-"}, bundle_coupon_code=${p.bundle_coupon_code ?? "-"}]`
          : "";
      console.log(`    ${p.id}  handle=${p.handle}  title="${p.title}"${stamped}`);
    }

    // Variant candidates for physical includes (frother / mug)
    const { data: variantCandidates } = await admin
      .from("product_variants")
      .select("id, product_id, title, sku")
      .eq("workspace_id", ws.id)
      .or(
        "title.ilike.%frother%,title.ilike.%mug%,sku.ilike.%frother%,sku.ilike.%mug%",
      );
    if ((variantCandidates || []).length) {
      console.log(`  Frother / mug variant candidates:`);
      for (const v of variantCandidates || []) {
        console.log(`    ${v.id}  sku=${v.sku ?? "-"}  title="${v.title ?? "-"}"  (product_id=${v.product_id})`);
      }
    }

    // Digital goods for the e-guide include
    const { data: digitalGoods } = await admin
      .from("digital_goods")
      .select("id, name, type, delivery")
      .eq("workspace_id", ws.id)
      .order("name", { ascending: true });
    if ((digitalGoods || []).length) {
      console.log(`  Digital goods:`);
      for (const g of digitalGoods || []) {
        console.log(`    ${g.id}  type=${g.type}  delivery=${g.delivery}  name="${g.name}"`);
      }
    }
    console.log("");
  }

  console.log("── Fill these five values in scripts/wire-starter-kit-offer.ts ──");
  console.log("  WORKSPACE_ID              = <the Superfoods workspace uuid>");
  console.log("  PRIMARY_PRODUCT_ID        = <the product whose bundle PDP renders the Starter Kit>");
  console.log("  FROTHER_VARIANT_ID        = <the frother product_variants uuid>");
  console.log("  MUG_VARIANT_ID            = <the mug product_variants uuid>");
  console.log("  EGUIDE_DIGITAL_GOOD_ID    = <the e-guide digital_goods uuid, type=downloadable>");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
