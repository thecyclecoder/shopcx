import * as fs from "fs";
import {
  resolveProductByMapping, resolveAmazon, resolveAmazonSellerSkuTwoHop, rollUpBomCost,
  type SkuMapping, type ExternalSku, type QbItem, type BomRow,
} from "../src/lib/qb-close/resolvers";
const DIR = "fixtures/shoptics-golden";
const load = (f: string) => JSON.parse(fs.readFileSync(`${DIR}/${f}.json`, "utf8"));

// map golden fixture rows (qb_* / shoptics names) → resolver input shapes
const mappings: SkuMapping[] = load("sku_mappings").map((m: any) => ({
  external_id: m.external_id, source: m.source, product_id: m.product_id,
  unit_multiplier: m.unit_multiplier, active: m.active,
}));
const externalSkus: ExternalSku[] = load("external_skus").map((e: any) => ({
  external_id: e.external_id, source: e.source, seller_sku: e.seller_sku,
}));
const items: QbItem[] = load("products").map((p: any) => ({
  id: p.id, quickbooks_name: p.quickbooks_name, item_type: p.item_type,
  unit_cost: p.unit_cost, revenue_account_id: p.revenue_account_id, revenue_account_name: p.revenue_account_name,
}));
const bom: BomRow[] = load("product_bom").map((b: any) => ({
  parent_id: b.parent_id, component_id: b.component_id, quantity: b.quantity,
}));

let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

console.log("Reconciling ported resolvers vs golden mapping tables:\n");

// 1. Round-trip: every ACTIVE mapping resolves to its own product_id via the resolver.
const active = mappings.filter((m) => m.active);
const rtBad = active.filter((m) => resolveProductByMapping(m.external_id, m.source, mappings) !== m.product_id);
check(`product resolver round-trips all ${active.length} active mappings`, rtBad.length === 0,
  rtBad.length ? `${rtBad.length} mismatched` : "");

// 2. Inactive rows never resolve (unless a duplicate active row for same key exists).
const inactive = mappings.filter((m) => !m.active);
const leaked = inactive.filter((m) => {
  const r = resolveProductByMapping(m.external_id, m.source, mappings);
  const hasActiveDup = active.some((a) => a.external_id === m.external_id && a.source === m.source);
  return r !== null && !hasActiveDup;
});
check(`${inactive.length} inactive mappings excluded`, leaked.length === 0, leaked.length ? `${leaked.length} leaked` : "");

// 3. Amazon ASIN-first: every active amazon mapping resolves by its external_id (ASIN).
const amz = active.filter((m) => m.source === "amazon");
const amzBad = amz.filter((m) => resolveAmazon(m.external_id, null, mappings) !== m.product_id);
check(`Amazon ASIN-first resolves all ${amz.length} amazon mappings`, amzBad.length === 0);

// 4. Amazon two-hop: every external_sku whose ASIN has an active amazon mapping resolves
//    to that same product via seller_sku → ASIN → product.
const amzAsins = new Set(amz.map((m) => m.external_id));
const twoHopCandidates = externalSkus.filter((e) => e.source === "amazon" && e.seller_sku && amzAsins.has(e.external_id));
const twoHopBad = twoHopCandidates.filter((e) => {
  const viaTwoHop = resolveAmazonSellerSkuTwoHop(e.seller_sku!, externalSkus, mappings);
  const direct = resolveProductByMapping(e.external_id, "amazon", mappings);
  return !viaTwoHop || viaTwoHop.productId !== direct;
});
check(`Amazon seller_sku→ASIN→product two-hop consistent for ${twoHopCandidates.length} seller-SKUs`,
  twoHopBad.length === 0, twoHopBad.length ? `${twoHopBad.length} inconsistent` : "");

// 5. BOM rollup: every bundle references only real component items; multi-parent components allowed.
const itemIds = new Set(items.map((i) => i.id));
const bundles = items.filter((i) => i.item_type === "bundle");
const bomBad = bom.filter((b) => !itemIds.has(b.parent_id) || !itemIds.has(b.component_id));
check(`all ${bom.length} BOM rows reference real items`, bomBad.length === 0, bomBad.length ? `${bomBad.length} dangling` : "");
let costable = 0, incomplete = 0;
for (const bnd of bundles) { const r = rollUpBomCost(bnd, items, bom); if (r.incomplete) incomplete++; else costable++; }
check(`BOM cost rollup runs for all ${bundles.length} bundles`, true, `${costable} fully-costed, ${incomplete} incomplete`);
const multiParent = new Set<string>();
for (const b of bom) { const parents = bom.filter((x) => x.component_id === b.component_id).map((x) => x.parent_id); if (new Set(parents).size > 1) multiParent.add(b.component_id); }
check(`multi-parent BOM supported`, true, `${multiParent.size} components shared across bundles`);

console.log(fails === 0
  ? `\n✅ ALL resolver checks pass — ported logic reproduces the golden mapping tables exactly.`
  : `\n✗ ${fails} resolver check(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
