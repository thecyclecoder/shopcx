import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  for(const t of ["ticket_analyses","ticket_resolution_events","tickets","proposed_playbooks","playbook_proposals","triage_runs"]){
    const { count, error } = await db.from(t).select("*",{count:"exact",head:true});
    console.log(`  ${t}: ${error? "MISSING":count+" rows"}`);
  }
  process.exit(0);
})();
