import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(120);
  const refund = (jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="refund-idempotency-guard-in-commerce-refund-facade";});
  console.log("=== refund spec jobs (newest first) ===");
  for (const j of refund.slice(0,8)) console.log(`  [${(j as any).status}] ${(j as any).kind} created=${(j as any).created_at?.slice(11,19)} upd=${(j as any).updated_at?.slice(11,19)}`);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
