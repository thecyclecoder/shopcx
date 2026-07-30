import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data: g } = await db.from("goals").select("*").eq("workspace_id",WS).eq("slug","sol-ticket-direction-then-cheap-execution").maybeSingle();
  if(!g){console.log("NOT FOUND");process.exit(0);}
  console.log("goal:", (g as any).title.slice(0,60));
  console.log("status:", (g as any).status, "| owner:", (g as any).owner, "| proposer:", (g as any).proposer_function);
  const { data: ms } = await db.from("goal_milestones").select("position,title").eq("goal_id",(g as any).id).order("position",{ascending:true});
  console.log("milestones:", (ms||[]).length);
  for(const m of ms||[]) console.log(`  M${(m as any).position}: ${(m as any).title}`);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
