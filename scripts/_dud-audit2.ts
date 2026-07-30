import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { activeAdsetLifetimeMetrics, detectMetaCpaLosers } from "../src/lib/media-buyer/meta-cpa-signal";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const POL={ earlyTrim:30000, trimAtc:8000, trimCpm:10000, crownCpa:15000, holdBand:22000, crownSpend:45000, crownPurch:8, maxSpend:120000 };
(async()=>{
  const admin=createAdminClient();
  const {data:latest}=await admin.from("iteration_scorecards_daily").select("snapshot_date").eq("workspace_id",WS).eq("level","adset").order("snapshot_date",{ascending:false}).limit(1).maybeSingle();
  const sd=(latest as any)?.snapshot_date;
  const {data:acctRows}=await admin.from("iteration_scorecards_daily").select("meta_ad_account_id").eq("workspace_id",WS).eq("level","adset").eq("snapshot_date",sd).eq("effective_status","ACTIVE");
  const accts=[...new Set((acctRows||[]).map((r:any)=>String(r.meta_ad_account_id)))];
  console.log(`snapshot ${sd} · ${accts.length} accounts with active adsets`);
  let anyCrown=false, anyDud=false;
  for(const acct of accts){
    const rows:any[]=await activeAdsetLifetimeMetrics(admin,WS,acct).catch(()=>[]);
    console.log(`\n== acct ${acct.slice(0,10)} (${rows.length} active) ==`);
    for(const r of rows.sort((a,b)=>b.spend_cents-a.spend_cents)){
      const sp=r.spend_cents/100, cpa=r.purchases>0?r.spend_cents/r.purchases/100:null;
      const cpm=r.impressions>0?(r.spend_cents/r.impressions)*10:0;
      const cpAtc=r.add_to_cart>=2?r.spend_cents/r.add_to_cart/100:null;
      let v="testing";
      if(r.purchases>=POL.crownPurch && cpa!==null && cpa*100<=POL.crownCpa && r.spend_cents>=POL.crownSpend){v="👑CROWN";anyCrown=true;}
      else if(r.purchases>0 && cpa!==null && cpa*100<=POL.holdBand) v="converter(hold)";
      else if(r.spend_cents>=POL.maxSpend){v="DEADLINE-DUD";anyDud=true;}
      else if(r.purchases===0 && r.spend_cents>=POL.crownSpend){v="0-PURCH DUD";anyDud=true;}
      else if(r.spend_cents>=POL.earlyTrim){
        const bad=[cpAtc!==null&&cpAtc*100>POL.trimAtc&&"$/ATC",cpm*100>POL.trimCpm&&"CPM",r.clicks>=30&&r.add_to_cart===0&&"clk-no-ATC"].filter(Boolean);
        if(bad.length){v=`EARLY-DUD(${bad.join("+")})`;anyDud=true;} else v="past$300 ok";
      } else v="<$300 protected";
      console.log(`  $${sp.toFixed(0).padStart(5)} p=${r.purchases} cpa=${cpa!==null?"$"+cpa.toFixed(0):"—"} atc=${r.add_to_cart} $/atc=${cpAtc!==null?"$"+cpAtc.toFixed(0):"—"} cpm=$${cpm.toFixed(0)} → ${v} [${(r.label||r.object_id).slice(0,22)}]`);
    }
    const losers=await detectMetaCpaLosers(admin,{workspaceId:WS,metaAdAccountId:acct,earlyTrimMinSpendCents:POL.earlyTrim,trimMaxCostPerAtcCents:POL.trimAtc,trimMaxCpmCents:POL.trimCpm,crownMaxCpaCents:POL.crownCpa,holdBandMaxCpaCents:POL.holdBand,crownMinSpendCents:POL.crownSpend,crownMinPurchases:POL.crownPurch,maxTestSpendCents:POL.maxSpend}).catch(()=>[]);
    console.log(`  → detector flags ${losers.length} loser(s): ${losers.map((l:any)=>l.targetObjectId.slice(0,10)+" $"+(l.spendCents/100).toFixed(0)).join(", ")||"none"}`);
  }
  console.log(`\nSUMMARY: crown due=${anyCrown} · dud due=${anyDud}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
