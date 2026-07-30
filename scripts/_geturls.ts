import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const ids=process.argv.slice(2);
  for(const cid of ids){
    const {data:v}=await admin.from("ad_videos").select("static_jpg_url").eq("campaign_id",cid).limit(1).single();
    console.log((v as any)?.static_jpg_url);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
