import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { setSpecStatus } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", SLUG="refund-idempotency-guard-in-commerce-refund-facade";
(async () => {
  const db = createAdminClient();
  const cols = "deferred, auto_build, vale_pass, status, blocked_by";
  const { data: before } = await db.from("specs").select(cols).eq("workspace_id",WS).eq("slug",SLUG).maybeSingle();
  console.log("BEFORE:", JSON.stringify(before));
  if ((before as any)?.deferred) {
    await setSpecStatus(WS, SLUG, null, "ceo"); // clears deferred=false, status=null → derives in_review
    const { data: after } = await db.from("specs").select(cols).eq("workspace_id",WS).eq("slug",SLUG).maybeSingle();
    console.log("AFTER un-park:", JSON.stringify(after));
  } else {
    console.log("already un-parked (deferred falsy) — no change");
  }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
