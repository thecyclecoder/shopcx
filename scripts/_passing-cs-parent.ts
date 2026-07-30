import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  for(const slug of ["clarification-turns-send-full-message-not-bare-question","human-directives-hard-gates-over-ticket-ai","ticket-merge-summary-and-context-cap"]){
    const {data:s}=await db.from("specs").select("parent_ref,parent_kind,vale_pass,parent_prose,parent").eq("workspace_id",WS).eq("slug",slug).maybeSingle();
    if(s) console.log(`${slug.slice(0,40)}: vale=${(s as any).vale_pass} ref=${(s as any).parent_ref}\n   prose=${((s as any).parent_prose||(s as any).parent||"").slice(0,160)}`);
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
