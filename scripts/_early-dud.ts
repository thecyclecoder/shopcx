import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data}=await admin.from("iteration_policies").select("*").eq("workspace_id",WS).order("created_at",{ascending:false}).limit(1);
  const p:any=(data||[])[0]||{};
  const keys=Object.keys(p).filter(k=>/dud|trim|kill|early|deadline|hold|min_spend|floor|purch|sale|band|crown/i.test(k));
  for(const k of keys) console.log(`  ${k} = ${JSON.stringify(p[k])}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
