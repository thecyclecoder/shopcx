import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const uid=(await db.from("workspace_members").select("user_id").eq("workspace_id",WS).eq("role","owner").limit(1)).data?.[0]?.user_id;
  if(!uid){console.log("no owner");process.exit(1);}

  // (b) approve backfill retries (apply-script method + table exists now)
  const BF="be78ec7a-02d9-4fd8-a054-5feade6a705a";
  for(const aid of ["amraua6xw0","amraua6xw1","amraua6xw2"]){
    const r = await approveRoadmapAction(WS, uid, { jobId: BF, actionId: aid, decision: "approve", notes: "order_refunds exists now; source column is additive+idempotent; backfill dedups on (order_id,request_key). Approved retry." });
    console.log("backfill", aid, "->", r.ok?"approved":JSON.stringify(r).slice(0,120));
  }

  // (a) decline AP's dead db-push (broken: $SUPABASE_POOLER_URL unset on box)
  const AP="f984a9fb-6eac-4518-ba29-c9db7f1eaa7d";
  const r2 = await approveRoadmapAction(WS, uid, { jobId: AP, actionId: "amraskfth0", decision: "decline", notes: "db push --include-all is broken on the builder ($SUPABASE_POOLER_URL unset → connects to a dead local socket). NOT approving. AP also blocked because its Phase-2 step-handler code (check_vaulted_pm) is not on main yet, so seeding active playbooks now is unsafe. AP resumes once the builder db-push env is fixed (spec authored) and the code merges." });
  console.log("AP amraskfth0 ->", r2.ok?"declined":JSON.stringify(r2).slice(0,160));
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
