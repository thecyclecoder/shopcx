import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data: pbs } = await db.from("playbooks").select("*").in("name",["Assisted Order Purchase","Assisted Subscription Purchase"]).eq("workspace_id",WS);
  for(const p of pbs||[]){
    console.log(`\n=== ${(p as any).name} ===`);
    console.log("  is_active:", (p as any).is_active, "| priority:", (p as any).priority);
    console.log("  trigger_intents:", JSON.stringify((p as any).trigger_intents));
    console.log("  trigger_patterns:", JSON.stringify((p as any).trigger_patterns));
    const { data: steps } = await db.from("playbook_steps").select("step_order,type,name,config").eq("playbook_id",(p as any).id).order("step_order",{ascending:true});
    for(const s of steps||[]) console.log(`  step ${(s as any).step_order}: ${(s as any).type} — ${(s as any).name} ${JSON.stringify((s as any).config)}`);
  }
  // How many other active playbooks exist + their priorities (does AP override?)
  const { data: all } = await db.from("playbooks").select("name,priority,is_active,trigger_intents").eq("workspace_id",WS).eq("is_active",true).order("priority",{ascending:false});
  console.log("\n=== all ACTIVE playbooks in workspace (priority desc) ===");
  for(const p of all||[]) console.log(`  [${(p as any).priority}] ${(p as any).name}`);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
