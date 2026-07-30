import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken, listAdSets } from "../src/lib/meta-ads";
import { fetchMetaAdInsights } from "../src/lib/ads/ad-insights-sdk";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE_ACCT = "2352876514967984";
const COFFEE_CAMP = "120252196683350184";   // Amazing Coffee testing campaign (from cohort)
const CREAMER_CAMP = "120252353694390184";

async function main() {
  const token = await getMetaUserToken(WS);
  if (!token) { console.log("no token"); return; }

  console.log("=== live ad-insights (maximum), aggregated by adSet ===");
  const ins = await fetchMetaAdInsights(token, COFFEE_ACCT, { datePreset: "maximum" });
  // aggregate by adSetId
  const byAdset = new Map<string, any>();
  for (const r of ins.values()) {
    const k = r.adSetId || "(none)";
    const cur = byAdset.get(k) ?? { adSet: r.adSet, campaign: r.campaign, spend:0, impressions:0, linkClicks:0, addToCart:0, purchases:0 };
    cur.spend += r.spend; cur.impressions += r.impressions; cur.linkClicks += r.linkClicks;
    cur.addToCart += r.addToCart; cur.purchases += r.purchases;
    byAdset.set(k, cur);
  }
  for (const [id, a] of byAdset) {
    const cpm = a.impressions? (a.spend/a.impressions*1000):0;
    const ctr = a.impressions? (a.linkClicks/a.impressions*100):0;
    const cac = a.purchases? (a.spend/a.purchases):null;
    console.log(`  [${a.campaign}] adset ${id} "${a.adSet}"`);
    console.log(`     spend $${a.spend.toFixed(0)} impr ${a.impressions} CPM $${cpm.toFixed(2)} CTR ${ctr.toFixed(2)}% ATC ${a.addToCart} P ${a.purchases} CAC ${cac?("$"+cac.toFixed(0)):"—"}`);
  }

  console.log("\n=== listAdSets: Coffee campaign structure ===");
  const coffeeSets = await listAdSets(token, COFFEE_ACCT, COFFEE_CAMP);
  for (const s of coffeeSets) console.log(`  ${s.id} "${s.name}" [${s.status}]`);
  console.log("=== listAdSets: Creamer campaign structure ===");
  const creamerSets = await listAdSets(token, COFFEE_ACCT, CREAMER_CAMP);
  for (const s of creamerSets) console.log(`  ${s.id} "${s.name}" [${s.status}]`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
