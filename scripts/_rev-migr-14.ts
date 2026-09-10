import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const snaps: any[] = [];
  for (let from=0;;from+=1000){ const {data} = await admin.from("appstle_contract_snapshots").select("appstle_contract_id,status,next_billing_date").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; snaps.push(...data); if(data.length<1000)break; }
  const subs = new Map<string,string>();
  for (let from=0;;from+=1000){ const {data} = await admin.from("subscriptions").select("shopify_contract_id, status").eq("workspace_id", WS).range(from, from+999); if(!data?.length)break; data.forEach((s:any)=>subs.set(String(s.shopify_contract_id), s.status)); if(data.length<1000)break; }
  const x: Record<string, number> = {};
  for (const s of snaps) { const k = `appstle=${s.status} / ours=${subs.get(String(s.appstle_contract_id)) ?? "MISSING"}`; x[k]=(x[k]||0)+1; }
  console.log(x);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
