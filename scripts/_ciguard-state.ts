import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("status,kind,spec_slug,updated_at,payload").order("created_at",{ascending:false}).limit(150);
  const g=(jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="ci-guard-table-refs-have-migrations";});
  for(const j of g.slice(0,5)) console.log(`[${(j as any).status}] ${(j as any).kind} upd=${(j as any).updated_at?.slice(11,19)}`);
  if(!g.length) console.log("(no jobs yet)");
  process.exit(0);
})();
