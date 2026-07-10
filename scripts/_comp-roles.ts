import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  // distinct comp_role values + counts
  const {data}=await admin.from("customers").select("comp_role, is_internal").not("comp_role","is",null);
  const counts:Record<string,number>={};
  for(const r of data??[]) counts[String((r as any).comp_role)]=(counts[String((r as any).comp_role)]??0)+1;
  console.log("comp_role values in use:", JSON.stringify(counts,null,0));
  // who has comp_role set
  const {data:comped}=await admin.from("customers").select("id,first_name,last_name,email,phone,comp_role,comp_note,is_internal").not("comp_role","is",null).limit(40);
  console.log("\nComped customers:");
  for(const c of comped??[]) console.log(JSON.stringify({name:`${c.first_name??""} ${c.last_name??""}`.trim(),email:c.email,phone:c.phone,comp_role:c.comp_role,note:c.comp_note}));
  // search Alan Gold
  console.log("\n=== Alan / Gold exact ===");
  const {data:alan}=await admin.from("customers").select("id,first_name,last_name,email,phone,tags,comp_role")
    .or("first_name.ilike.%alan%,email.ilike.%alangold%,email.ilike.%agold%").limit(20);
  for(const c of alan??[]) console.log(JSON.stringify({id:c.id,name:`${c.first_name??""} ${c.last_name??""}`.trim(),email:c.email,phone:c.phone}));
}
main().catch(e=>{console.error(e);process.exit(1);});
