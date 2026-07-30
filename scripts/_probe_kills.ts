import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { getTestingResults } from "../src/lib/ads/testing-results-sdk";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KILLED_ADSET="120252196709210184";
const GRAPH="https://graph.facebook.com/v21.0";
async function gget(path:string,params:Record<string,string>,token:string){const u=new URL(`${GRAPH}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.append(k,v);u.searchParams.append("access_token",token);const r=await fetch(u);return r.json();}
async function main(){
  const admin=createAdminClient();
  const token=await getMetaUserToken(WS);
  // 1) what is the killed adset?
  const a=await gget(`${KILLED_ADSET}`,{fields:"name,effective_status,campaign{id,name}"},token!);
  console.log("=== the adset in the kill message ===");
  console.log(`  ${KILLED_ADSET} [${a.effective_status}] "${a.name}"`);
  console.log(`  campaign: ${a.campaign?.name} (${a.campaign?.id})`);

  // 2) is that campaign one of our 6 TEST campaigns?
  const { data: coh } = await admin.from("media_buyer_test_cohorts").select("test_meta_campaign_id").eq("workspace_id",WS).eq("is_active",true);
  const testCamps=new Set((coh||[]).map((c:any)=>c.test_meta_campaign_id).filter(Boolean));
  console.log(`  → is a TEST campaign? ${testCamps.has(a.campaign?.id) ? "YES" : "NO — it's outside the 6 testing campaigns"}`);

  // 3) do any ACTIVE tests qualify for a kill (dud tier) per our decision-tree?
  console.log("\n=== ACTIVE tests currently at DUD tier (would qualify for a kill) ===");
  const res=await getTestingResults(admin, WS);
  let anyDud=false;
  for(const g of res.products) for(const r of g.rows){
    if(r.active && r.tier==="dud"){ anyDud=true;
      console.log(`  ${g.productTitle}: ${r.adsetName.slice(0,34)} — $${Math.round(r.spendCents/100)} spend, ${r.purchases} sales, CAC ${r.cacCents?"$"+Math.round(r.cacCents/100):"—"}`); }
  }
  if(!anyDud) console.log("  NONE — no active test meets the kill bar (deadline $1,200 w/o hold band, or ≥$300 with 0 sales).");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
