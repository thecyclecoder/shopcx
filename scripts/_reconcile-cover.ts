import { createAdminClient } from "./_bootstrap";
import { computeCover } from "../src/lib/logistics/cover";
const SL = "2902cdeb-1895-42f1-9a4e-6597414c618e";
const SL_VARIANT = "42614433480877";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id").not("shopify_access_token_encrypted","is",null);
  const wsId = ws![0].id;

  // Ground truth: raw all-source variant units in June (matches Shopify Admin = 1049)
  const { data: orders } = await admin.from("orders")
    .select("source_name, line_items")
    .eq("workspace_id", wsId)
    .gte("created_at", "2026-06-01T00:00:00Z").lte("created_at", "2026-06-30T23:59:59Z");
  let allSrc = 0; const bySrc = new Map<string, number>();
  for (const o of orders ?? []) {
    for (const l of (Array.isArray(o.line_items) ? o.line_items : []) as any[]) {
      if (String(l.variant_id) !== SL_VARIANT) continue;
      const q = l.quantity ?? 0; allSrc += q;
      bySrc.set(o.source_name ?? "null", (bySrc.get(o.source_name ?? "null") ?? 0) + q);
    }
  }
  console.log("=== RAW variant_id=" + SL_VARIANT + " June (all source_name) ===");
  console.log("total units:", allSrc, "  (Shopify Admin ground truth = 1049)");
  console.log("by source_name:", [...bySrc.entries()].sort((a,b)=>b[1]-a[1]));

  // Engine output
  const rows = await computeCover(admin, wsId, [{ bundleQbId: SL }], "2026-06-01", "2026-06-30", 1);
  const r = rows[0];
  console.log("\n=== computeCover (months=1) SL ===");
  console.log({ name: r.name, burnShopify: r.burnShopify, burnInternal: r.burnInternal, burnAmazon: r.burnAmazon, burnPerMonth: r.burnPerMonth });
  console.log("shop+int =", r.burnShopify + r.burnInternal, " vs raw shopify/internal-source subset");
})();
