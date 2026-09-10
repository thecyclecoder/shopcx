import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("appstle_contract_id,status,raw").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  let consumedStillAllocating=0, consumedNoAlloc=0; const ex:string[]=[];
  let activeLimitedAllocating=0; const ex2:string[]=[];
  for (const s of snaps) {
    const raw = s.raw as any; if(!raw) continue;
    const nodes = (raw?.discounts?.nodes??[]).filter((d:any)=>String(d.type)==="CODE_DISCOUNT");
    if (!nodes.length) continue;
    const lnodes = raw.lines?.nodes ?? raw.lines?.edges?.map((e:any)=>e.node) ?? [];
    const allocTitles = new Set<string>();
    let allocSum=0;
    for (const n of lnodes) for (const a of (n.discountAllocations||[])) { allocSum += parseFloat(a?.amount?.amount??"0"); }
    for (const d of nodes) {
      const lim = d.recurringCycleLimit, used = Number(d.usageCount??0);
      if (lim != null && used >= lim) { if (allocSum>0) { consumedStillAllocating++; if(ex.length<5) ex.push(`${s.appstle_contract_id} "${d.title}" lim=${lim} used=${used} allocSum=${allocSum}`);} else consumedNoAlloc++; }
      else if (lim != null && allocSum>0) { activeLimitedAllocating++; if (ex2.length<4) ex2.push(`${s.appstle_contract_id} "${d.title}" lim=${lim} used=${used} allocSum=${allocSum}`); }
    }
  }
  console.log({ consumedStillAllocating, consumedNoAlloc, activeLimitedAllocating });
  console.log("consumed but still allocating:", ex);
  console.log("active limited allocating:", ex2);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
