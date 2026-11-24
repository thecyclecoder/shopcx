import { listPhaseChecks, grepModeOf } from "../src/lib/spec-phase-checks-table";
import { createAdminClient } from "../src/lib/supabase/admin";
const db=createAdminClient();
const {data:spec}=await db.from("specs").select("id").eq("slug","ai-shopping-agent-mcp").single();
const {data:phases}=await db.from("spec_phases").select("id,position,title,status,build_sha").eq("spec_id",spec!.id).order("position");
for (const p of phases!) { console.log("P",p.position,p.status,(p.build_sha??"").slice(0,8),p.title);
  for (const c of await listPhaseChecks(p.id)) if (c.exec_kind==="grep") console.log("   ",JSON.stringify(c.params),"->",grepModeOf(c.params as any),"|",c.description); }
