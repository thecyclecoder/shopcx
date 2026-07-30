import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { activeAdsetLifetimeMetrics, detectMetaCpaLosers } from "../src/lib/media-buyer/meta-cpa-signal";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const POL={ earlyTrim:30000, trimAtc:8000, trimCpm:10000, crownCpa:15000, holdBand:22000, crownSpend:45000, crownPurch:8, maxSpend:120000 };
(async()=>{
  const admin=createAdminClient();
  // discover meta ad accounts in use
  const {data:accts}=await admin.from("meta_ad_accounts").select("meta_ad_account_id,name").eq("workspace_id",WS);
  const list=(accts||[]).map((a:any)=>({id:String(a.meta_ad_account_id),name:a.name}));
  console.log("accounts:", list.map(a=>`${a.name}=${a.id}`).join(" | ")||"(none via meta_ad_accounts)");
  for(const acct of list){
    const rows:any[]=await activeAdsetLifetimeMetrics(admin, WS, acct.id).catch((e)=>{console.log(`  ${acct.name}: metrics err ${String(e).slice(0,80)}`);return [];});
    console.log(`\n===== ${acct.name} (${rows.length} active adsets) =====`);
    console.log("  spend  purch   CPA   impr   clk   ATC  $/ATC   CPM   → status vs early-dud rules");
    for(const r of rows.sort((a,b)=>b.spend_cents-a.spend_cents)){
      const sp=r.spend_cents/100, cpa=r.purchases>0?r.spend_cents/r.purchases/100:null;
      const cpm=r.impressions>0?(r.spend_cents/r.impressions)*10:0; // cents*1000/100 = /10 for $
      const cpAtc=r.add_to_cart>=2?r.spend_cents/r.add_to_cart/100:null;
      let verdict="testing";
      if(r.purchases>0 && cpa!==null && cpa*100<=POL.holdBand) verdict="CONVERTER (hold)";
      else if(r.spend_cents>=POL.maxSpend && !(r.purchases>=POL.crownPurch && cpa!==null && cpa*100<=POL.crownCpa)) verdict="DEADLINE-DUD";
      else if(r.purchases===0 && r.spend_cents>=POL.crownSpend) verdict="0-PURCH BACKSTOP DUD";
      else if(r.spend_cents>=POL.earlyTrim){
        const badAtc=cpAtc!==null && cpAtc*100>POL.trimAtc;
        const badCpm=cpm*100>POL.trimCpm;
        const clicksNoAtc=r.clicks>=30 && r.add_to_cart===0;
        if(badAtc||badCpm||clicksNoAtc) verdict=`EARLY-DUD (${[badAtc&&"$/ATC",badCpm&&"CPM",clicksNoAtc&&"clk-no-ATC"].filter(Boolean).join("+")})`;
        else verdict="past $300, signals OK";
      } else verdict="<$300 (protected)";
      console.log(`  $${sp.toFixed(0).padStart(5)} ${String(r.purchases).padStart(3)}  ${cpa!==null?("$"+cpa.toFixed(0)).padStart(5):"   —"} ${String(r.impressions).padStart(6)} ${String(r.clicks).padStart(5)} ${String(r.add_to_cart).padStart(4)} ${cpAtc!==null?("$"+cpAtc.toFixed(0)).padStart(5):"   —"} ${("$"+cpm.toFixed(0)).padStart(5)}  → ${verdict}  [${(r.label||r.object_id).slice(0,24)}]`);
    }
    // what Bianca's detector actually returns
    const losers=await detectMetaCpaLosers(admin,{workspaceId:WS,metaAdAccountId:acct.id,earlyTrimMinSpendCents:POL.earlyTrim,trimMaxCostPerAtcCents:POL.trimAtc,trimMaxCpmCents:POL.trimCpm,crownMaxCpaCents:POL.crownCpa,holdBandMaxCpaCents:POL.holdBand,crownMinSpendCents:POL.crownSpend,crownMinPurchases:POL.crownPurch,maxTestSpendCents:POL.maxSpend}).catch(()=>[]);
    console.log(`  → detectMetaCpaLosers returns ${losers.length} adset(s) to trim: ${losers.map((l:any)=>l.targetObjectId.slice(0,12)+" $"+(l.spendCents/100).toFixed(0)).join(", ")||"none"}`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,300));process.exit(1);});
