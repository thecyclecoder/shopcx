import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const cids=["a23d1e4a-4a91-48f7-9b8d-b17da73a13b6","cf7b81a4-6070-4a16-a6a5-6aa4934e053d"];
  const {data:pj}=await admin.from("ad_publish_jobs").select("*").in("campaign_id",cids);
  for(const r of (pj??[]) as any[]) console.log("PJ:",JSON.stringify({id:r.id,campaign_id:r.campaign_id,publish_status:r.publish_status,meta_ad_id:r.meta_ad_id,meta_adset_id:r.meta_adset_id,created_at:r.created_at}));
  const {data:c,error}=await admin.from("ad_campaigns").select("id,workspace_id,product_id,status,created_at").in("id",cids);
  if(error){console.log("camp err:",error.message);}
  console.log("campaigns found:",(c??[]).length);
  for(const r of (c??[]) as any[]) console.log("CAMP:",JSON.stringify(r));
  // what product?
  const pids=[...new Set((c??[]).map((r:any)=>r.product_id).filter(Boolean))];
  if(pids.length){const {data:p}=await admin.from("products").select("id,title").in("id",pids);console.log("products:",JSON.stringify(p));}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
