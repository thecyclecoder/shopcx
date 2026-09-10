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

  let tempBakedContracts=0, tempBakedCents=0;
  let dblContracts=0, dblCents=0;
  let shipLossContracts=0, shipLossCents=0;
  let activeCount=0;
  for (const s of snaps) {
    const active = subs.get(String(s.appstle_contract_id)) === "active" && s.status === "ACTIVE";
    if (!active) continue;
    activeCount++;
    const raw = s.raw as any; if (!raw) continue;
    const nodes = raw?.discounts?.nodes ?? [];
    const hasFreeShip = nodes.some((d:any)=>d.targetType==="SHIPPING_LINE");
    if ((s.delivery_price_cents??0)>0 && !hasFreeShip) { shipLossContracts++; shipLossCents += s.delivery_price_cents; }
    // total allocated on lines
    const lnodes = raw.lines?.nodes ?? raw.lines?.edges?.map((e:any)=>e.node) ?? [];
    let allocTotal = 0;
    for (const n of lnodes) for (const a of (n.discountAllocations||[])) allocTotal += Math.round(parseFloat(a?.amount?.amount ?? "0")*100);
    if (!allocTotal) continue;
    // limited-cycle discounts present?
    const limited = nodes.filter((d:any)=>d.recurringCycleLimit != null);
    if (limited.length) { tempBakedContracts++; tempBakedCents += allocTotal; }
    const carry = M.carryableCodes(raw);
    if (carry.length) { dblContracts++; dblCents += carry.reduce((a,c)=>a+Math.round(c.amount*100)*(c.appliesOnEachItem?0:1),0); }
  }
  console.log({ activeCount });
  console.log("TEMPORARY (limited-cycle) discount baked into a PERMANENT grandfather:", { contracts: tempBakedContracts, centsPerCycle: tempBakedCents, dollars: (tempBakedCents/100).toFixed(2) });
  console.log("Fixed code carried AND already baked into grandfather (double-applied first cycle):", { contracts: dblContracts, dollars: (dblCents/100).toFixed(2) });
  console.log("Shipping given away (deliveryPrice 0.00, no free-ship discount today):", { contracts: shipLossContracts, dollars: (shipLossCents/100).toFixed(2) });
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
