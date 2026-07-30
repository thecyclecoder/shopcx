import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const a=createAdminClient();
  const { data:j }=await a.from("agent_jobs").select("questions,pending_actions,session_note,log_tail,spec_branch").eq("id","b675923c-864a-4ef6-a644-970efb0b3047").maybeSingle();
  console.log("spec_branch:", (j as any)?.spec_branch);
  console.log("questions:", JSON.stringify((j as any)?.questions)?.slice(0,700));
  console.log("pending_actions:", JSON.stringify((j as any)?.pending_actions)?.slice(0,500));
  console.log("session_note:", (j as any)?.session_note?.slice(0,300));
})().then(()=>process.exit(0));
