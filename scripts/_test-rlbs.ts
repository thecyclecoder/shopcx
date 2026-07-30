import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const t=Date.now();
  const { data, error } = await a.rpc("roadmap_latest_build_signals", { p_workspace_id: WS });
  const ms=Date.now()-t;
  if(error) console.log(`❌ roadmap_latest_build_signals FAILED in ${ms}ms: ${error.message}`);
  else console.log(`✅ roadmap_latest_build_signals OK in ${ms}ms — returned ${Array.isArray(data)?data.length+" rows":JSON.stringify(data).slice(0,80)}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
