import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const {data}=await admin.from("agent_jobs").select("*").eq("workspace_id",WS).limit(1);
  const cols=data?.[0]?Object.keys(data[0]):[];
  console.log("agent_jobs columns:", cols.join(", "));
  console.log("\nhas pending_action?", cols.includes("pending_action"));
  const cands=cols.filter(c=>/pending|action|note|session/i.test(c));
  console.log("action/note-ish cols:", cands.join(", "));
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
