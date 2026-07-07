import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const db = createAdminClient();
  const { data } = await db.from("playbooks").select("name,workspace_id,is_active").in("name",["Assisted Order Purchase","Assisted Subscription Purchase"]);
  console.log("total rows:", (data||[]).length);
  const byWs:Record<string,number>={}; for(const p of data||[]) byWs[(p as any).workspace_id]=(byWs[(p as any).workspace_id]||0)+1;
  console.log("workspaces with these playbooks:", Object.keys(byWs).length, "| per-ws counts:", JSON.stringify(byWs));
  console.log("in OUR workspace fdc11e10:", (data||[]).filter((p:any)=>p.workspace_id===WS).length, "rows");
  // is check_vaulted_pm on main yet?
  process.exit(0);
})();
