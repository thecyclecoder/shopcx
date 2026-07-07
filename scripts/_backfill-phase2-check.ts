import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  // current order_refunds state by source
  const { data: rows } = await db.from("order_refunds").select("source, vendor").limit(1000);
  const bySource:Record<string,number>={}, byVendor:Record<string,number>={};
  for(const r of rows||[]){ bySource[(r as any).source]=(bySource[(r as any).source]||0)+1; byVendor[(r as any).vendor]=(byVendor[(r as any).vendor]||0)+1; }
  console.log("order_refunds total:", (rows||[]).length, "| by source:", JSON.stringify(bySource), "| by vendor:", JSON.stringify(byVendor));

  // has a from-events action ALREADY succeeded on the backfill job?
  const { data: jobs } = await db.from("agent_jobs").select("id,status,pending_actions").order("created_at",{ascending:false}).limit(150);
  const bf=(jobs||[]).filter((j:any)=>{const s=j.spec_slug||(j.payload&&(j.payload.slug||j.payload.spec_slug));return s==="backfill-order-refunds-ledger-from-history";});
  console.log("\n=== all from-events actions across backfill jobs (status) ===");
  for(const j of bf){
    for(const a of ((j as any).pending_actions||[])){
      if((a.cmd||"").includes("from-events")) console.log(`  job ${(j as any).id.slice(0,8)} [${(j as any).status}] action ${a.id} status=${a.status||"pending"} cmd=${(a.cmd||"").slice(-40)}`);
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
