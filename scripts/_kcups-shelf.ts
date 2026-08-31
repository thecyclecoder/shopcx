/**
 * K-Cups has a seeded competitor LIST but apparently no competitor ADS.
 * Separate the two, then run the ACTUAL sourcing function Dahlia uses and see what she gets.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { listCompetitors } from "../src/lib/competitors";
import { resolveShelfProductIds, getProvenCompetitorAngles } from "../src/lib/ads/creative-sourcing";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";

async function main() {
  const a = createAdminClient();
  const { data: prods, error: pe } = await a.from("products")
    .select("id,title,competitor_shelf_source_id").eq("workspace_id", WS);
  if (pe) throw new Error(`products: ${pe.message}`);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));

  console.log("=== shelf pointers ===");
  for (const p of prods ?? []) {
    if (p.competitor_shelf_source_id) console.log(`   ${String(p.title).padEnd(26)} → ${title.get(String(p.competitor_shelf_source_id))}`);
  }

  console.log(`\n=== resolveShelfProductIds(admin, productId) ===`);
  for (const [label, pid] of [["K-Cups", KCUPS], ["Amazing Coffee", COFFEE]] as const) {
    const ids = await resolveShelfProductIds(a, pid);
    console.log(`   ${label.padEnd(15)} → [${ids.map((i) => title.get(String(i)) ?? String(i).slice(0, 8)).join(", ")}]`);
  }

  const comps = await listCompetitors({ workspaceId: WS });
  const compByProduct = new Map<string, number>();
  for (const c of comps) {
    const pid = String((c as Record<string, unknown>).product_id);
    compByProduct.set(pid, (compByProduct.get(pid) ?? 0) + 1);
  }

  const { data: skels, error: se } = await a.from("creative_skeletons")
    .select("id,product_id,advertiser,days_running,created_at").eq("workspace_id", WS);
  if (se) throw new Error(`creative_skeletons: ${se.message}`);
  const skelBy = new Map<string, { total: number; d30: number; d60: number }>();
  for (const s of skels ?? []) {
    const k = String(s.product_id);
    const e = skelBy.get(k) ?? { total: 0, d30: 0, d60: 0 };
    e.total += 1;
    const d = Number(s.days_running ?? 0);
    if (d >= 30) e.d30 += 1;
    if (d >= 60) e.d60 += 1;
    skelBy.set(k, e);
  }

  console.log(`\n=== competitor LIST vs competitor ADS ===`);
  console.log(`product                        competitors   skeletons  >=30d  >=60d`);
  for (const p of prods ?? []) {
    const pid = String(p.id);
    const c = compByProduct.get(pid) ?? 0;
    const s = skelBy.get(pid) ?? { total: 0, d30: 0, d60: 0 };
    if (!c && !s.total) continue;
    const flag = c > 0 && s.total === 0 ? "   ← LIST but NO ADS" : "";
    console.log(`   ${String(p.title).slice(0, 28).padEnd(30)} ${String(c).padStart(5)}     ${String(s.total).padStart(5)}  ${String(s.d30).padStart(5)}  ${String(s.d60).padStart(5)}${flag}`);
  }
  console.log(`\ntotals: competitors=${comps.length}  skeletons=${(skels ?? []).length}`);

  console.log(`\n=== what Dahlia ACTUALLY gets (getProvenCompetitorAngles) ===`);
  for (const [label, pid] of [["K-Cups", KCUPS], ["Amazing Coffee", COFFEE]] as const) {
    const r = await getProvenCompetitorAngles(a, WS, { productId: pid }) as Record<string, unknown>;
    const angles = (r.angles ?? []) as unknown[];
    console.log(`   ${label.padEnd(15)} angles=${angles.length}  usedFallback=${r.usedFallback}  keys=${Object.keys(r).join(",")}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
