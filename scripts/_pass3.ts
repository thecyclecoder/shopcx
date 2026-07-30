import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { detectMetaCpaWinners, detectMetaCpaLosers } from "../src/lib/media-buyer/meta-cpa-signal";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const POL={ trimAtc:8000, trimCpm:10000, crownCpa:15000, holdBand:22000, crownSpend:45000, crownPurch:8, maxSpend:120000, earlyTrim:30000 };
(async()=>{
  const admin=createAdminClient();
  const {data:latest}=await admin.from("iteration_scorecards_daily").select("snapshot_date").eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
  const sd=(latest as any)?.snapshot_date;
  const {data:acctRows}=await admin.from("iteration_scorecards_daily").select("meta_ad_account_id").eq("workspace_id",WS).eq("level","adset").eq("snapshot_date",sd).eq("effective_status","ACTIVE");
  const accts=[...new Set((acctRows||[]).map((r:any)=>String(r.meta_ad_account_id)))];
  console.log(`snapshot ${sd} · ${accts.length} accounts`);
  let crowns:any[]=[], losers:any[]=[];
  for(const acct of accts){
    const w=await detectMetaCpaWinners(admin,{workspaceId:WS,metaAdAccountId:acct,crownMaxCpaCents:POL.crownCpa,crownMinSpendCents:POL.crownSpend,crownMinPurchases:POL.crownPurch}).catch(()=>[]);
    const l=await detectMetaCpaLosers(admin,{workspaceId:WS,metaAdAccountId:acct,earlyTrimMinSpendCents:POL.earlyTrim,trimMaxCostPerAtcCents:POL.trimAtc,trimMaxCpmCents:POL.trimCpm,crownMaxCpaCents:POL.crownCpa,holdBandMaxCpaCents:POL.holdBand,crownMinSpendCents:POL.crownSpend,crownMinPurchases:POL.crownPurch,maxTestSpendCents:POL.maxSpend}).catch((e)=>{console.log("loser err",acct.slice(0,8),String(e).slice(0,60));return [];});
    crowns.push(...w.map((x:any)=>({acct:acct.slice(0,8),...x}))); losers.push(...l.map((x:any)=>({acct:acct.slice(0,8),...x})));
  }
  console.log(`\n👑 CROWNS DUE: ${crowns.length}`);
  for(const c of crowns) console.log(`  ${c.acct} adset=${(c.metaAdsetId||c.targetObjectId||"?").slice(0,14)} spend=$${((c.spendCents||0)/100).toFixed(0)} cpa=$${((c.cppCents||c.cpaCents||0)/100).toFixed(0)}`);
  console.log(`\n🔴 LOSERS/DUDS DUE: ${losers.length}`);
  for(const l of losers) console.log(`  ${l.acct} adset=${(l.targetObjectId||"?").slice(0,14)} spend=$${((l.spendCents||0)/100).toFixed(0)}`);

  // Did Bianca act? recent iteration_actions (24h)
  const since=new Date(Date.now()-24*3600*1000).toISOString();
  const {data:acts}=await admin.from("iteration_actions").select("action_type,level,object_id,created_at").eq("workspace_id",WS).gte("created_at",since).order("created_at",{ascending:false}).limit(20);
  console.log(`\nBIANCA iteration_actions (24h): ${acts?.length||0}`);
  for(const a of (acts||[]).slice(0,10) as any[]) console.log(`  ${a.created_at?.slice(5,16)} ${a.action_type} ${a.level} ${String(a.object_id).slice(0,12)}`);
  // policy mode
  const {data:pol}=await admin.from("iteration_policies").select("mode,trust_meta_reported_signal").eq("workspace_id",WS).order("created_at",{ascending:false}).limit(1).maybeSingle();
  console.log("policy mode:", (pol as any)?.mode, "trust_meta:", (pol as any)?.trust_meta_reported_signal);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
