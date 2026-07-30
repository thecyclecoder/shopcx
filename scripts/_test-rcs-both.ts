import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const a=createAdminClient();
  const { data: ws } = await a.from("workspaces").select("id,name,created_at").order("created_at");
  console.log(`workspaces: ${ws?.length}`);
  for(const w of (ws||[]) as any[]){
    // sms-subscribed count for context
    const { count } = await a.from("customers").select("id",{count:"exact",head:true}).eq("workspace_id",w.id).eq("sms_marketing_status","subscribed");
    const t=Date.now();
    const { data, error } = await a.rpc("refresh_customer_segments", { p_workspace_id: w.id, p_all: false });
    const ms=Date.now()-t;
    console.log(`\n▸ ${w.name} (${w.id.slice(0,8)}) — sms_subscribed=${count}`);
    if(error) console.log(`   ❌ FAILED in ${ms}ms: ${error.message} | code=${(error as any).code}`);
    else console.log(`   ✅ OK in ${ms}ms — refreshed ${data} rows`);
  }
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,250));process.exit(1);});
