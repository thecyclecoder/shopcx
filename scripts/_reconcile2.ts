import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { detectMetaCpaLosers } from "../src/lib/media-buyer/meta-cpa-signal";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const POL={ trimAtc:8000, trimCpm:10000, crownCpa:15000, holdBand:22000, crownSpend:45000, crownPurch:8, maxSpend:120000, earlyTrim:30000 };
(async()=>{
  const admin=createAdminClient();
  const {data:latest}=await admin.from("iteration_scorecards_daily").select("snapshot_date").eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
  const sd=(latest as any)?.snapshot_date;
  const {data:acctRows}=await admin.from("iteration_scorecards_daily").select("meta_ad_account_id").eq("workspace_id",WS).eq("level","adset").eq("snapshot_date",sd).eq("effective_status","ACTIVE");
  const accts=[...new Set((acctRows||[]).map((r:any)=>String(r.meta_ad_account_id)))];
  const loserIds:string[]=[];
  for(const acct of accts){
    const l=await detectMetaCpaLosers(admin,{workspaceId:WS,metaAdAccountId:acct,earlyTrimMinSpendCents:POL.earlyTrim,trimMaxCostPerAtcCents:POL.trimAtc,trimMaxCpmCents:POL.trimCpm,crownMaxCpaCents:POL.crownCpa,holdBandMaxCpaCents:POL.holdBand,crownMinSpendCents:POL.crownSpend,crownMinPurchases:POL.crownPurch,maxTestSpendCents:POL.maxSpend}).catch(()=>[]);
    for(const x of l as any[]) loserIds.push(String(x.targetObjectId));
  }
  const since=new Date(Date.now()-26*3600*1000).toISOString();
  const {data:acts}=await admin.from("iteration_actions").select("object_id").eq("workspace_id",WS).eq("action_type","pause").gte("created_at",since);
  const paused=new Set((acts||[]).map((a:any)=>String(a.object_id)));
  console.log("FULL flagged loser ids:", loserIds.join(", "));
  console.log("\nreconcile (exact match vs Bianca's 24h pauses):");
  let unpaused=0;
  for(const id of loserIds){
    const hit=paused.has(id);
    if(!hit) unpaused++;
    console.log(`  ${id}: Bianca-paused=${hit?"YES ✓":"NO ⚠️ still active"}`);
  }
  console.log(`\n→ ${unpaused}/${loserIds.length} flagged duds NOT yet paused by Bianca`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
