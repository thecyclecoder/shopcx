import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("appstle_contract_id,status,raw").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  const rej: Record<string,number> = {}; const tt: Record<string,number> = {};
  let rejCarried = 0; const rejEx: string[]=[];
  let shipFixed=0;
  let discPaged=0;
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  for (const s of snaps) {
    const raw = s.raw as any; if(!raw) continue;
    if (raw?.discounts?.pageInfo?.hasNextPage) discPaged++;
    for (const d of (raw?.discounts?.nodes ?? [])) {
      if (String(d.type)!=="CODE_DISCOUNT") continue;
      rej[String(d.rejectionReason)] = (rej[String(d.rejectionReason)]||0)+1;
      tt[String(d.targetType)] = (tt[String(d.targetType)]||0)+1;
      if (d.rejectionReason) { const c = M.carryableCodes(raw); if (c.some(x=>x.title===d.title)) { rejCarried++; if(rejEx.length<5) rejEx.push(`${s.appstle_contract_id} ${d.title} rej=${d.rejectionReason}`); } }
      if (d.targetType==="SHIPPING_LINE" && d?.value?.amount?.amount != null) shipFixed++;
    }
  }
  console.log({ rej, tt, rejCarried, rejEx, shipFixed, discPaged });
  // lines pagination on the raw contract
  let linesPaged=0, maxLines=0;
  for (const s of snaps) { const raw=s.raw as any; if(!raw) continue; if (raw.lines?.pageInfo?.hasNextPage) linesPaged++; const n=(raw.lines?.nodes??raw.lines?.edges??[]).length; if(n>maxLines)maxLines=n; }
  console.log({ linesPaged, maxLines });
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
