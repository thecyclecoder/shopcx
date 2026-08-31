/**
 * Correct the Avalara tax codes on our products. CEO-directed 2026-08-31.
 *
 * Two verified defects (live Avalara quotes + the definitions endpoint, 2026-08-31):
 *   1. PF050144 is NOT a real Avalara tax code. Avalara silently degrades it to P0000000
 *      (Tangible Personal Property) and taxes supplements as general merchandise.
 *   2. PC040100 is "Clothing And Related Products", NOT food — our coffee/creamer/K-Cups
 *      have been classified as clothing.
 *
 * Correct codes, confirmed against Avalara's own definitions endpoint:
 *   PF050700 — Food And Food Ingredients-dietary supplements (supplement facts on label)
 *   PF050002 — Food And Food Ingredients - Food for Home Consumption or Basic Groceries
 *
 * Product classification per the CEO: Creatine, Superfood Tabs and Ashwavana products are
 * supplements; coffee and creamer are not.
 *
 * The workspace default moves to P0000000 — an unclassified product must fall back to fully
 * taxable, never inherit an exemption it may not be entitled to.
 *
 * Pass --apply.
 */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

const SUPPLEMENT = "PF050700";
const GROCERY = "PF050002";
const FALLBACK = "P0000000";

const PLAN: Record<string, string> = {
  "Creatine Prime+": SUPPLEMENT,
  "Superfood Tabs": SUPPLEMENT,
  "Ashwavana Zen Relax": SUPPLEMENT,
  "Ashwavana Guru Focus": SUPPLEMENT,
  "Apple Cider Vinegar Gummies": SUPPLEMENT,
  "Sleep Gummies": SUPPLEMENT,
  "Amazing Coffee": GROCERY,
  "Amazing Coffee K-Cups": GROCERY,
  "Amazing Creamer": GROCERY,
};

async function main() {
  const a = createAdminClient();
  const { data: prods, error } = await a.from("products").select("id,title,avalara_tax_code").eq("workspace_id", WS);
  if (error) throw new Error(`products: ${error.message}`);

  const changes: Array<{ id: string; title: string; from: string; to: string }> = [];
  for (const p of prods ?? []) {
    const want = PLAN[String(p.title)];
    if (!want) continue;
    const from = String(p.avalara_tax_code ?? "NULL");
    if (from === want) continue;
    changes.push({ id: String(p.id), title: String(p.title), from, to: want });
  }

  console.log(`products to update: ${changes.length}`);
  for (const c of changes) console.log(`   ${c.title.padEnd(30)} ${c.from.padEnd(10)} → ${c.to}`);

  const { data: ws } = await a.from("workspaces").select("avalara_default_tax_code").eq("id", WS).maybeSingle();
  console.log(`\nworkspace default: ${ws?.avalara_default_tax_code} → ${FALLBACK}`);

  const untouched = (prods ?? []).filter((p) => !PLAN[String(p.title)]);
  console.log(`\nleft alone (${untouched.length}):`);
  for (const p of untouched) console.log(`   ${String(p.title).padEnd(30)} ${p.avalara_tax_code ?? "NULL"}`);

  if (!APPLY) { console.log("\nDRY RUN — pass --apply."); return; }

  for (const c of changes) {
    const { error: ue } = await a.from("products").update({ avalara_tax_code: c.to }).eq("id", c.id).eq("workspace_id", WS);
    if (ue) throw new Error(`update ${c.title}: ${ue.message}`);
  }
  const { error: we } = await a.from("workspaces").update({ avalara_default_tax_code: FALLBACK }).eq("id", WS);
  if (we) throw new Error(`workspace default: ${we.message}`);

  const { data: after } = await a.from("products").select("title,avalara_tax_code").eq("workspace_id", WS);
  console.log(`\n=== AFTER ===`);
  for (const p of after ?? []) console.log(`   ${String(p.title).padEnd(30)} ${p.avalara_tax_code ?? "NULL"}`);
  const { data: wsAfter } = await a.from("workspaces").select("avalara_default_tax_code").eq("id", WS).maybeSingle();
  console.log(`   workspace default: ${wsAfter?.avalara_default_tax_code}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
