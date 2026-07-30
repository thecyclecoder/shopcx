import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const { data } = await admin.from("specs").select("priority").eq("workspace_id",WS).not("priority","is",null).limit(500);
  const vals:Record<string,number>={}; for(const s of data||[]) vals[String(s.priority)]=(vals[String(s.priority)]||0)+1;
  console.log("distinct priority values in use:", JSON.stringify(vals));
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
