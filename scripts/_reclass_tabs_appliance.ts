import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";
async function main(){
  const admin=createAdminClient();
  const {data,error,count}=await admin.from("creative_skeletons")
    .update({status:"archived"},{count:"exact"})
    .eq("workspace_id",WS).eq("product_id",TABS).eq("advertiser","Live It Up LLC").eq("status","analyzed")
    .select("id");
  if(error){console.error("update err:",error.message);return;}
  console.log(`archived ${count} appliance skeletons (analyzed→archived, reversible)`);
  const {count:rem}=await admin.from("creative_skeletons").select("*",{count:"exact",head:true})
    .eq("workspace_id",WS).eq("product_id",TABS).eq("status","analyzed").not("hook","is",null).gte("days_running",45);
  console.log(`remaining good analyzed+dr>=45: ${rem}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
