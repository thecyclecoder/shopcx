import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const ids=["a23d1e4a-4a91-48f7-9b8d-b17da73a13b6","cf7b81a4-6070-4a16-a6a5-6aa4934e053d"];
  const {data:c}=await admin.from("ad_campaigns")
    .select("id,product_id,status,landing_url,created_at,name,meta_campaign_id").in("id",ids);
  for(const r of (c??[]) as any[]){
    console.log(JSON.stringify(r,null,1));
  }
  // product names
  const pids=[...new Set((c??[]).map((r:any)=>r.product_id))];
  const {data:p}=await admin.from("products").select("id,title").in("id",pids);
  console.log("products:", JSON.stringify(p));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
