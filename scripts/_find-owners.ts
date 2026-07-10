import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  const {data:sample}=await admin.from("customers").select("*").limit(1);
  console.log("CUSTOMER COLUMNS:", sample?.[0]?Object.keys(sample[0]).join(", "):"(no rows)");
  const names=["Stecher","Gold","Ralston"];
  for(const n of names){
    const {data,error}=await admin.from("customers")
      .select("id, workspace_id, first_name, last_name, email, phone, tags, created_at")
      .or(`last_name.ilike.%${n}%,first_name.ilike.%${n}%,email.ilike.%${n}%`)
      .limit(10);
    console.log(`\n=== ${n} === ${error?.message??""}`);
    for(const c of data??[]) console.log(JSON.stringify({id:c.id,name:`${c.first_name??""} ${c.last_name??""}`.trim(),email:c.email,phone:c.phone,tags:c.tags}));
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
