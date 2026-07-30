import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken, listAdSets } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ASH_ACCT="2395577783853111";
const SHARED_CAMP="120249256874270682";
const ZEN="48bfa48c-b8db-42f9-9303-19c70ab8e7a1";
const GURU="f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb";
async function main(){
  const admin=createAdminClient();
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  const adsets=await listAdSets(token, ASH_ACCT, SHARED_CAMP);
  // attribute each adset -> product via ad_publish_jobs.campaign_id -> ad_campaigns.product_id
  const ids=adsets.map(a=>a.id);
  const { data: pj } = await admin.from("ad_publish_jobs").select("meta_adset_id, campaign_id").in("meta_adset_id", ids.length?ids:["_"]).not("campaign_id","is",null);
  const campIds=[...new Set((pj||[]).map((r:any)=>r.campaign_id))];
  const { data: ac } = await admin.from("ad_campaigns").select("id, product_id").in("id", campIds.length?campIds:["_"]);
  const acProd=new Map((ac||[]).map((r:any)=>[r.id, r.product_id]));
  const adsetProd=new Map<string,string>();
  for(const r of (pj||[]) as any[]){ const p=acProd.get(r.campaign_id); if(p&&!adsetProd.has(r.meta_adset_id)) adsetProd.set(r.meta_adset_id, p); }
  const pName:Record<string,string>={[ZEN]:"ZEN RELAX",[GURU]:"GURU FOCUS"};
  console.log(`shared campaign ${SHARED_CAMP} — ${adsets.length} adsets:`);
  for(const a of adsets){ const prod=adsetProd.get(a.id); console.log(`  ${a.id} [${a.status}] ${pName[prod||""]||"?"} — ${a.name}`); }
  // cohorts
  const { data: coh } = await admin.from("media_buyer_test_cohorts").select("id, product_id, test_meta_campaign_id, is_active").eq("workspace_id",WS).in("product_id",[ZEN,GURU]);
  console.log("\ncohorts:", JSON.stringify(coh,null,2));
  // ashwavana account uuid + page/ig defaults from guru cohort
  const { data: acct } = await admin.from("meta_ad_accounts").select("id, meta_account_id, meta_account_name").eq("meta_account_id",ASH_ACCT).maybeSingle();
  console.log("account:", JSON.stringify(acct));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
