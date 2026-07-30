import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  console.log("calling refresh_customer_segments via PostgREST (.rpc) — same path as the Inngest fn...");
  const t=Date.now();
  const { data, error } = await a.rpc("refresh_customer_segments", { p_workspace_id: WS, p_all: false });
  console.log(`  elapsed ${Date.now()-t}ms`);
  if(error) console.log(`  ❌ STILL ERRORING: ${error.message} | code=${(error as any).code} | hint=${(error as any).hint}`);
  else console.log(`  ✅ OK — returned: ${JSON.stringify(data)} (rows refreshed)`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
