import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin = createAdminClient();
  // publish jobs that landed a meta_adset_id, with campaign_id -> ad_campaigns.product_id
  const { data: pj } = await admin.from("ad_publish_jobs")
    .select("meta_adset_id, meta_campaign_id, campaign_id, ad_name, meta_ad_id, publish_status")
    .eq("workspace_id", WS).not("meta_adset_id","is",null).order("created_at",{ascending:false}).limit(20);
  const campIds = [...new Set((pj||[]).map((r:any)=>r.campaign_id).filter(Boolean))];
  const { data: ac } = await admin.from("ad_campaigns").select("id, product_id, name").in("id", campIds.length?campIds:["_"]);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id",WS);
  const pName = new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const acProd = new Map((ac||[]).map((a:any)=>[a.id, pName.get(a.product_id)??a.product_id]));
  console.log(`ad_publish_jobs w/ adset (${(pj||[]).length}):`);
  for(const r of (pj||[]) as any[]) console.log(`  adset ${r.meta_adset_id} camp ${r.meta_campaign_id} -> ${acProd.get(r.campaign_id)??"(no ad_campaign)"} | ${r.publish_status} | ${r.ad_name?.slice(0,40)}`);
  // also creative_test_outcomes adset->product
  const { data: cto } = await admin.from("creative_test_outcomes").select("meta_adset_id, product_id, outcome").eq("workspace_id",WS).not("meta_adset_id","is",null).limit(20);
  console.log(`\ncreative_test_outcomes w/ adset (${(cto||[]).length}):`);
  for(const r of (cto||[]) as any[]) console.log(`  adset ${r.meta_adset_id} -> ${pName.get(r.product_id)??r.product_id} [${r.outcome}]`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
