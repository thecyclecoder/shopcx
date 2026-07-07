import { loadEnv } from "./_bootstrap";
loadEnv();
import { getSpec } from "../src/lib/specs-table";
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const s = await getSpec(WS, "refund-idempotency-guard-in-commerce-refund-facade");
  if (!s) { console.log("spec NOT in specs table"); }
  else {
    console.log("status:", (s as any).status, "| intended:", (s as any).intended_status, "| phases:", (s.phases||[]).map((p:any)=>`${p.title?.slice(0,30)}=${p.status}`).join(" | "));
  }
  // is the guard actually in the code on main?
  const db = createAdminClient();
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
