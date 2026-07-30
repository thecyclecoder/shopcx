import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  // Sol goal + its milestones
  const { data: g } = await db.from("goals").select("id").eq("workspace_id",WS).eq("slug","sol-ticket-direction-then-cheap-execution").single();
  const { data: ms } = await db.from("goal_milestones").select("id,position,title").eq("goal_id",(g as any).id);
  const msIds = new Set((ms||[]).map((m:any)=>m.id));
  // specs tied to those milestones (Pia's decomposition)
  const { data: specs } = await db.from("specs").select("slug,title,status,intended_status,milestone_id,vale_pass,auto_build").in("milestone_id",[...msIds]);
  console.log("=== specs under the Sol goal (Pia's plan):", (specs||[]).length, "===");
  for(const s of specs||[]){
    const m=(ms||[]).find((x:any)=>x.id===(s as any).milestone_id);
    console.log(`  [M${(m as any)?.position}] ${(s as any).slug} — status=${(s as any).status} intended=${(s as any).intended_status} vale=${(s as any).vale_pass} auto_build=${(s as any).auto_build}`);
  }
  // any plan-approval jobs needing approval
  const { data: jobs } = await db.from("agent_jobs").select("id,kind,status,spec_slug,questions,pending_actions").in("status",["needs_approval","needs_input"]).ilike("kind","%plan%");
  console.log("\n=== plan jobs needing approval:", (jobs||[]).length, "===");
  for(const j of jobs||[]) console.log(`  [${(j as any).status}] ${(j as any).kind} ${(j as any).spec_slug||""}`);
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
