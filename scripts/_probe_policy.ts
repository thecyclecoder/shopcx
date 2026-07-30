import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("iteration_policies").select("*").eq("workspace_id",WS).order("created_at",{ascending:false}).limit(1);
  const p=data?.[0] as any;
  if(!p){console.log("(no policy)");return;}
  const keys=Object.keys(p).filter(k=>/crown|trim|min|max|spend|cpa|purch|deadline|hold|roas|scale/i.test(k));
  for(const k of keys) console.log(`  ${k} = ${p[k]}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
