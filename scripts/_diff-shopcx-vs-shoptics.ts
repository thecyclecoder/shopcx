/**
 * Apples-to-apples: ShopCX's shadow InventoryAdjustment vs SHOPTICS' live audit for the same
 * month, with the same corrections applied on both sides.
 *
 * Diffing ShopCX against the POSTED golden is misleading now — that golden was produced before
 * the 3PL on_hand / refund-units fixes, so a match would mean reproducing the old bugs. This
 * compares the two engines on equal footing instead.
 *
 * Usage: npx tsx scripts/_diff-shopcx-vs-shoptics.ts 2026-06   (shoptics dev server on :3999)
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildMonthEndArtifacts } from "../src/lib/qb-close/month-end";
import type { ShopifyOrder } from "../src/lib/qb-close/journal-entry";

const MONTH = process.argv[2] || "2026-06";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

interface AuditRow { product_id: string; name: string; variance: number; bom_items?: AuditRow[] }

async function main() {
  const admin = createAdminClient();

  // ShopCX side — no live Shopify orders needed; the adjustment does not use them.
  const art = await buildMonthEndArtifacts({ workspaceId: WS, month: MONTH, admin, orders: [] as ShopifyOrder[] });
  const shopcx = new Map<string, number>();
  for (const l of art.inventoryAdjustment) shopcx.set(String(l.itemRef), (shopcx.get(String(l.itemRef)) ?? 0) + l.qtyDiff);

  // Shoptics side — its live audit, which now carries the same corrections.
  const res = await fetch(`http://localhost:3999/api/inventory-audit?month=${MONTH}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`shoptics audit ${res.status} — is the dev server running on :3999?`);
  const audit = (await res.json()) as { finished_goods_with_bom?: AuditRow[]; standalone_finished_goods?: AuditRow[] };

  const { data: items } = await admin.from("qb_items").select("id, quickbooks_id, quickbooks_name").eq("workspace_id", WS);
  const nameOf = new Map((items ?? []).map((i) => [String(i.quickbooks_id), i.quickbooks_name]));

  // Bridge shoptics product_id -> quickbooks_id EXACTLY, from the Shoptics products table.
  // Matching on quickbooks_name instead collapses distinct items that share a name (e.g. a
  // finished good and its 10-count sibling), which manufactures phantom paired diffs.
  const fsSync = await import("fs");
  const env: Record<string, string> = {};
  for (const l of fsSync.readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const sProds = (await (
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/products?select=id,quickbooks_id`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Range: "0-4999" },
      cache: "no-store",
    })
  ).json()) as { id: string; quickbooks_id: string | number }[];
  const sProductToQbId = new Map(sProds.map((p) => [p.id, String(p.quickbooks_id)]));

  const shoptics = new Map<string, number>();
  const seen = new Set<string>();
  const add = (r: AuditRow) => {
    if (seen.has(r.product_id)) return;
    seen.add(r.product_id);
    const q = Math.round(r.variance);
    if (!q) return;
    const qbId = sProductToQbId.get(r.product_id);
    if (!qbId) return;
    shoptics.set(qbId, (shoptics.get(qbId) ?? 0) + q);
  };
  for (const fg of audit.finished_goods_with_bom ?? []) for (const c of fg.bom_items ?? []) add(c);
  for (const s of audit.standalone_finished_goods ?? []) add(s);

  const keys = [...new Set([...shopcx.keys(), ...shoptics.keys()])];
  const rows = keys
    .map((k) => ({ k, a: shopcx.get(k) ?? 0, b: shoptics.get(k) ?? 0 }))
    .filter((r) => r.a !== r.b)
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));

  console.log(`\nInventoryAdjustment · ShopCX vs Shoptics (both corrected) — ${MONTH}\n`);
  console.log(`  ShopCX lines: ${shopcx.size} · Shoptics lines: ${shoptics.size} · differing: ${rows.length}`);
  if (rows.length) {
    console.log(`\n  ${"item".padEnd(46)}${"shopcx".padStart(9)}${"shoptics".padStart(10)}${"delta".padStart(8)}`);
    for (const r of rows.slice(0, 30))
      console.log(`  ${String(nameOf.get(r.k) ?? `qb ${r.k}`).slice(0, 46).padEnd(46)}${String(r.a).padStart(9)}${String(r.b).padStart(10)}${String(r.a - r.b).padStart(8)}`);
  } else {
    console.log(`\n  ✅ IDENTICAL — ShopCX reproduces Shoptics' corrected audit exactly.`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
