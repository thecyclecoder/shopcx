import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const CUST = "7f215e32-a825-4a55-b558-9630dd2357c9";
const TIDS = ["49ddd6c4-9894-4474-b925-fffe19a175c8","e671e536-cde6-43cb-91bb-b4113e94492f","4f513c1f-c16d-4a48-b43a-cf3569460b66","a818cb97-de33-4c90-b222-7a802f8e345c","3184df04"];
(async () => {
  const db = createAdminClient();
  const { data: js } = await db.from("journey_sessions").select("*").eq("customer_id",CUST).order("created_at",{ascending:true});
  console.log("=== journey_sessions for customer:", (js||[]).length, "===");
  for (const s of js||[]) console.log(`  ${(s as any).created_at?.slice(0,16)} type=${(s as any).journey_type??(s as any).journey_definition_id??(s as any).type} step=${(s as any).current_step??(s as any).step} outcome=${(s as any).outcome??(s as any).status} ticket=${String((s as any).ticket_id).slice(0,8)}`);
  // playbook sessions
  const { data: pb } = await db.from("tickets").select("id,playbook_id,playbook_step,playbook_context").eq("customer_id",CUST);
  console.log("\n=== ticket playbook state ===");
  for (const t of pb||[]) if((t as any).playbook_id||(t as any).playbook_step) console.log(`  ${String((t as any).id).slice(0,8)} pb=${(t as any).playbook_id} step=${(t as any).playbook_step} ctx=${JSON.stringify((t as any).playbook_context).slice(0,120)}`);
  process.exit(0);
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
