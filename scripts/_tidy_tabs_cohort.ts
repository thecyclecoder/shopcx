import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const COHORT="867ccfe9-5ca0-4a4f-b9b5-1116792a659c";
async function main(){
  const admin=createAdminClient();
  const { data: b } = await admin.from("media_buyer_test_cohorts").select("adset_per_test, test_meta_adset_id, test_meta_campaign_id, product_id").eq("id",COHORT).maybeSingle();
  console.log("BEFORE:", JSON.stringify(b));
  const { error } = await admin.from("media_buyer_test_cohorts").update({ adset_per_test:true, test_meta_adset_id:null, updated_at:new Date().toISOString() }).eq("id",COHORT);
  if(error){console.error(error.message);process.exit(1);}
  const { data: a } = await admin.from("media_buyer_test_cohorts").select("adset_per_test, test_meta_adset_id, test_meta_campaign_id, product_id").eq("id",COHORT).maybeSingle();
  console.log("AFTER: ", JSON.stringify(a));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
