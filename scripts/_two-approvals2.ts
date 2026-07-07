import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  for (const [slug,jid] of [
    ["assisted-purchase-playbook","f984a9fb-6eac-4518-ba29-c9db7f1eaa7d"],
    ["backfill-order-refunds-ledger-from-history","be78ec7a-02d9-4fd8-a054-5feade6a705a"],
  ]) {
    const { data: j } = await db.from("agent_jobs").select("*").eq("id",jid).maybeSingle();
    console.log(`\n=== ${slug} === status=${(j as any).status}`);
    const pa=(j as any).pending_actions||[];  // TOP-LEVEL column
    console.log("pending_actions (top-level):", Array.isArray(pa)?pa.length:typeof pa);
    for(const a of (Array.isArray(pa)?pa:[])) {
      console.log(`  - id=${a.id} status=${a.status||"pending"} type=${a.type}`);
      console.log(`    cmd: ${(a.cmd||"").slice(0,90)}`);
      if(a.result) console.log(`    result: ${String(a.result).slice(0,140)}`);
    }
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
