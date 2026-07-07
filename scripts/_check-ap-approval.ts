import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(120);
  const ap = (jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="assisted-purchase-playbook";});
  for (const j of ap.slice(0,6)) {
    console.log(`[${(j as any).status}] ${(j as any).kind} created=${(j as any).created_at?.slice(11,19)} upd=${(j as any).updated_at?.slice(11,19)}`);
    const p=(j as any).payload||{};
    for (const k of ["approval_reason","reason","pending_action","question","action","decision_needed","pr_number","note","summary"]) if(p[k]) console.log("   ",k,":",JSON.stringify(p[k]).slice(0,300));
    for (const k of Object.keys(j as any)) if(/approval|pending|question|reason|action_needed/i.test(k)&&(j as any)[k]) console.log("   ."+k+":",JSON.stringify((j as any)[k]).slice(0,300));
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
