import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const duds=[{id:"120252355815780184",acct:"d6d619a5"},{id:"120250143054030326",acct:"2a97bb87"}];
(async()=>{
  const admin=createAdminClient();
  for(const d of duds){
    // lifetime metrics from meta_insights_daily
    const {data:ins}=await admin.from("meta_insights_daily").select("spend_cents,purchases,add_to_cart,clicks,impressions").eq("workspace_id",WS).eq("level","adset").eq("meta_object_id",d.id);
    let sp=0,p=0,atc=0,clk=0,imp=0; for(const r of (ins||[]) as any[]){sp+=r.spend_cents||0;p+=r.purchases||0;atc+=r.add_to_cart||0;clk+=r.clicks||0;imp+=r.impressions||0;}
    console.log(`\n▸ ${d.id} (acct ${d.acct})`);
    console.log(`  spend=$${(sp/100).toFixed(0)} purch=${p} atc=${atc} clk=${clk} cpa=${p>0?"$"+(sp/p/100).toFixed(0):"—"} → why dud: ${p===0?"0-purch":atc===0&&clk>=30?"clicks-no-ATC":"leading-signal"}`);
    // current scorecard status
    const {data:sc}=await admin.from("iteration_scorecards_daily").select("effective_status,snapshot_date").eq("workspace_id",WS).eq("object_id",d.id).order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
    console.log(`  scorecard: ${(sc as any)?.effective_status}@${(sc as any)?.snapshot_date}`);
  }
  // did Bianca's passes cover these 2 accounts? director_activity media_buyer (12h)
  const since=new Date(Date.now()-12*3600*1000).toISOString();
  const {data:da}=await admin.from("director_activity").select("action_kind,detail,created_at,metadata").eq("workspace_id",WS).ilike("action_kind","%media_buyer%").gte("created_at",since).order("created_at",{ascending:false}).limit(15);
  console.log(`\nmedia_buyer director_activity (12h): ${da?.length||0}`);
  for(const a of (da||[]).slice(0,12) as any[]){
    const m=JSON.stringify(a.metadata||{});
    const acctHit=duds.some(d=>m.includes(d.acct)||String(a.detail||"").includes(d.acct));
    console.log(`  ${a.created_at?.slice(5,16)} ${a.action_kind} ${String(a.detail||"").slice(0,80)}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
