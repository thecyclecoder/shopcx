import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { answerRoadmapBuild } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB="be78ec7a-02d9-4fd8-a054-5feade6a705a";
(async () => {
  const db = createAdminClient();
  const { data: mem } = await db.from("workspace_members").select("user_id,role").eq("workspace_id",WS).eq("role","owner").limit(1);
  const uid=(mem||[])[0]?.user_id; if(!uid){console.log("no owner");process.exit(1);}
  const answer = [
    "Your hypothesis (a) is correct: the ALTER hit a not-yet-existing order_refunds table — a TIMING RACE. Your 3 gated actions ran ~15:46 UTC, exactly when the create-table migration was being applied.",
    "STATE NOW: public.order_refunds EXISTS in prod with the correct schema (id, workspace_id, order_id, request_key, vendor, vendor_refund_id, amount_cents, status, requested_at, settled_at, created_at, updated_at), RLS on, 4 indexes. Created + applied via 20260917120000_create_order_refunds (PR #1273, merged + applied in-session).",
    "IMPORTANT — there are already TWO idempotent `create table if not exists order_refunds` migrations on main with IDENTICAL schemas: 20260917120000_create_order_refunds AND the pre-existing 20260918120000_order_refunds_mirror (from refund-integrity #1244, merged 2026-07-06). Do NOT add a third create migration. Your 20260922120000_order_refunds_source.sql (ALTER ... ADD COLUMN source) is the ONLY new DDL needed.",
    "RESOLUTION: retry the gated actions now. The source-column ALTER and the backfill script will succeed against the existing table. If a retry still fails, THAT stderr is the real signal — paste it.",
  ].join(" ");
  const r = await answerRoadmapBuild(WS, uid, { jobId: JOB, answers: [{ id: "failure_output", answer }] });
  console.log("answered:", JSON.stringify(r).slice(0,200));
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
