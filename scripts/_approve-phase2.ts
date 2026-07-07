import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", JOB="591ac32b-6bd5-434f-833c-d02c21db4c37";
(async () => {
  const db = createAdminClient();
  const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
  for(const [aid,label] of [["amrav4vkk0","dry-run (read-only)"],["amrav4vkk1","apply (idempotent insert)"]]){
    const r = await approveRoadmapAction(WS, uid!, { jobId:JOB, actionId:aid, decision:"approve", notes:"Phase 2 from-events backfill. Reviewed scripts/backfill-order-refunds-from-events.ts: dedups vs existing (vendor_refund_id + ON CONFLICT DO NOTHING on order_id,request_key), folds same refund_id, source='backfill'. Idempotent + additive. Approved." });
    console.log(aid, label, "->", r.ok?"approved":JSON.stringify(r).slice(0,140));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
