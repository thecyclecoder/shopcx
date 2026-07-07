import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(120);
  const j = (jobs||[]).find((x:any)=>{const s=x.spec_slug||(x.payload&&(x.payload.slug||x.payload.spec_slug));return s==="assisted-purchase-playbook" && x.status==="needs_approval";});
  if(!j){console.log("no needs_approval AP job");process.exit(0);}
  console.log("jobId:", (j as any).id, "| ws:", (j as any).workspace_id);
  const pa=((j as any).payload?.pending_actions)||[];
  for(const a of pa) console.log("  action:", a.id, a.type, "| cmd:", (a.cmd||"").slice(0,70));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
