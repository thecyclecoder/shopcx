import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("appstle_contract_id,status,raw,lines,delivery_price_cents").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  // usageCount distribution on CODE_DISCOUNT
  const uc: Record<string,number> = {}; const lim: Record<string,number> = {};
  let pctNonStructural=0; const pctNS: string[] = [];
  let shipDeliv=0, shipNoFree=0; const noFreeEx: string[]=[];
  for (const s of snaps) {
    const raw = s.raw as any; if (!raw) continue;
    const nodes = raw?.discounts?.nodes ?? [];
    const hasFreeShip = nodes.some((d:any)=>d.targetType==="SHIPPING_LINE" && d?.value?.percentage===100);
    if ((s.delivery_price_cents??0)>0) { shipDeliv++; if (!hasFreeShip) { shipNoFree++; if (noFreeEx.length<5) noFreeEx.push(`${s.appstle_contract_id} status=${s.status} deliv=${s.delivery_price_cents} discounts=${nodes.map((d:any)=>d.type+":"+d.targetType).join(",")}`); } }
    for (const d of nodes) {
      if (String(d.type)!=="CODE_DISCOUNT") continue;
      uc[String(d.usageCount)] = (uc[String(d.usageCount)]||0)+1;
      lim[String(d.recurringCycleLimit)] = (lim[String(d.recurringCycleLimit)]||0)+1;
      if (d?.value?.percentage != null && !/^Buy \d Discount/i.test(String(d.title))) { pctNonStructural++; if (pctNS.length<12) pctNS.push(`${s.appstle_contract_id} "${d.title}" ${d.value.percentage}% limit=${d.recurringCycleLimit} used=${d.usageCount} target=${d.targetType}`); }
    }
  }
  console.log("CODE_DISCOUNT usageCount dist:", uc);
  console.log("CODE_DISCOUNT recurringCycleLimit dist:", lim);
  console.log({ shipDeliv, shipNoFree }); console.log(noFreeEx);
  console.log("percentage codes that are NOT 'Buy N Discount':", pctNonStructural); console.log(pctNS);
  // the LOYALTY-15 contract in detail
  for (const id of ["27959525549","27959820461"]) {
    const s = snaps.find(x=>x.appstle_contract_id===id); if(!s) continue;
    console.log("\n=== ", id, "status", s.status, "deliv", s.delivery_price_cents);
    console.log("discounts:", JSON.stringify((s.raw as any).discounts.nodes.map((d:any)=>({t:d.title,type:d.type,v:d.value,tt:d.targetType,lim:d.recurringCycleLimit,used:d.usageCount}))));
    for (const n of ((s.raw as any).lines.nodes ?? (s.raw as any).lines.edges?.map((e:any)=>e.node) ?? [])) {
      console.log("  line", JSON.stringify({sku:n.sku,q:n.quantity,cur:n.currentPrice?.amount,disc:n.lineDiscountedPrice?.amount,allocs:(n.discountAllocations||[]).map((a:any)=>a?.amount?.amount)}));
    }
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
