import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: jobs } = await db.from("agent_jobs").select("*").order("created_at",{ascending:false}).limit(150);
  for (const slug of ["assisted-purchase-playbook","backfill-order-refunds-ledger-from-history"]) {
    const j=(jobs||[]).find((x:any)=>{const s=x.spec_slug||(x.payload&&(x.payload.slug||x.payload.spec_slug));return s===slug && x.status==="needs_approval";});
    if(!j){console.log(`\n${slug}: NO needs_approval job`);continue;}
    console.log(`\n=== ${slug} ===`);
    console.log("jobId:", (j as any).id, "| kind:", (j as any).kind, "| upd:", (j as any).updated_at?.slice(11,19), "| branch:", (j as any).spec_branch);
    const pa=((j as any).payload?.pending_actions)||[];
    console.log("pending_actions:", pa.length);
    for(const a of pa) console.log("  -", a.id, "|", a.type, "| cmd:", (a.cmd||"").slice(0,80), "| result:", (a.result||"").slice(0,120));
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
