import { loadEnv } from "./_bootstrap";
loadEnv();
import { listGoals, getGoal } from "../src/lib/goals-table";
import { listSpecs } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const goals = await listGoals(WS);
  for (const g of goals as any[]) {
    if (!/commerce|subscription|sdk|shopify/i.test(`${g.slug} ${g.title ?? ""}`)) continue;
    console.log(`GOAL ${g.slug} [${g.status}] — ${g.title}`);
    const full = await getGoal(WS, g.slug) as any;
    for (const m of full?.milestones ?? []) console.log(`   milestone: ${m.title} [${m.status ?? ""}]`);
  }
  const specs = await listSpecs(WS) as any[];
  console.log("\n=== specs mentioning shopify-subscriptions / commerce SDK:");
  for (const s of specs) {
    if (/commerce-sdk|shopify-subscription|subscription-sdk/i.test(s.slug)) console.log(`  ${s.status ?? "(null)"} | ${s.slug}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
