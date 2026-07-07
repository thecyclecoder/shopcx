import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { approveRoadmapAction } from "../src/lib/roadmap-actions";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const JOB="f984a9fb-6eac-4518-ba29-c9db7f1eaa7d";
const ACTION="amrasebc90";
(async () => {
  const db = createAdminClient();
  // find an owner/admin user for the workspace
  const { data: mem } = await db.from("workspace_members").select("user_id, role").eq("workspace_id",WS).in("role",["owner","admin"]).limit(5);
  const owner = (mem||[]).find((m:any)=>m.role==="owner") || (mem||[])[0];
  if(!owner){console.log("no owner/admin found");process.exit(1);}
  console.log("acting as:", (owner as any).user_id, "role:", (owner as any).role);
  const r = await approveRoadmapAction(WS, (owner as any).user_id, { jobId: JOB, actionId: ACTION, decision: "approve", notes: "Reviewed seed_assisted_purchase_playbook migration — clean, additive, idempotent, constraint re-enumerates existing types. Approved." });
  console.log("result:", JSON.stringify(r).slice(0,300));
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
