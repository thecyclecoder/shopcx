import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const ids=["495e65f2-6dd9-4a3f-885a-ca1a8b3cda5c","7f4fb4ef-b644-4fb2-995c-8e12112311fc"];
  for(const cid of ids){
    const {data:v}=await admin.from("ad_videos").select("id,static_jpg_url").eq("campaign_id",cid).limit(1).single();
    console.log(`${cid}\t${(v as any)?.static_jpg_url}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
