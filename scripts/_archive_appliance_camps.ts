import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const camps=["0b4d2ac6-3eac-4161-90ce-b912071070d8","0957c68f-d7fd-4759-93bd-b40766f27de3","780ee2c3-cb3f-44d7-9b64-14808d522a3f","ddb60370-ae60-40b5-9837-792a3a90a485"];
async function main(){
  const admin=createAdminClient();
  const {error,count}=await admin.from("ad_campaigns").update({status:"archived"},{count:"exact"})
    .eq("workspace_id",WS).in("id",camps).eq("status","ready");
  if(error){console.error("err:",error.message);return;}
  console.log(`archived ${count} appliance-master Tabs campaigns (were staged/ready, reversible)`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
