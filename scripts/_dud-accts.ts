import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data:latest}=await admin.from("iteration_scorecards_daily").select("snapshot_date")
    .eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
  console.log("latest snapshot:", (latest as any)?.snapshot_date);
  const {data}=await admin.from("iteration_scorecards_daily").select("meta_ad_account_id,effective_status")
    .eq("workspace_id",WS).eq("level","adset").eq("snapshot_date",(latest as any)?.snapshot_date);
  const byAcct:Record<string,{active:number,total:number}>={};
  for(const r of (data||[]) as any[]){ const a=String(r.meta_ad_account_id); byAcct[a]=byAcct[a]||{active:0,total:0}; byAcct[a].total++; if(r.effective_status==="ACTIVE")byAcct[a].active++; }
  for(const [a,c] of Object.entries(byAcct)) console.log(`  ${a} — ${c.active} ACTIVE / ${c.total} total`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
