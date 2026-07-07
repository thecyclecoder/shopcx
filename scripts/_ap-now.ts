import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(120);
  const ap=(jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="assisted-purchase-playbook";}).slice(0,4);
  for(const j of ap) console.log(`[${(j as any).status}] ${(j as any).kind} upd=${(j as any).updated_at?.slice(11,19)}`);
  process.exit(0);
})();
