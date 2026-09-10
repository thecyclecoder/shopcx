import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await M.loadPricingContext(WS, RULE);
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("*").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  const subs = new Map<string, any>();
  for (let from=0;;from+=1000){ const {data} = await admin.from("subscriptions").select("shopify_contract_id, status").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; data.forEach((s:any)=>subs.set(String(s.shopify_contract_id), s.status)); if(data.length<1000)break; }
  let upContracts=0, upCents=0, maxUp=0; const ex: string[]=[];
  let planUp=0;
  for (const s of snaps) {
    if (subs.get(String(s.appstle_contract_id)) !== "active" || s.status !== "ACTIVE") continue;
    const plan = M.planMigration(s as any, ctx);
    if (plan.blocked) continue;
    let realTotal = 0, curTotal = 0;
    for (const l of plan.lines) {
      curTotal += l.currentUnitCents * l.quantity;
      if (l.isProtection || !l.onRule) { realTotal += l.finalUnitCents * l.quantity; continue; }
      realTotal += M.shopifyLineMath(l.baseCents, l.quantity, ctx.snsPct, plan.breakPct, l.grandfatherUnitCents).lineTotalCents;
    }
    const d = realTotal - curTotal;
    if (d > 0) { upContracts++; upCents += d; if (d>maxUp) maxUp=d; if (ex.length<6) ex.push(`${s.appstle_contract_id} +${d}c  (plan says ${plan.newTotalCents-plan.currentTotalCents}c)`); }
    if (plan.newTotalCents - plan.currentTotalCents > 0) planUp++;
  }
  console.log({ upContracts, upCentsTotal: upCents, maxUpCents: maxUp, planSaysUp: planUp });
  console.log(ex);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
