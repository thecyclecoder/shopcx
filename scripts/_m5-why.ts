import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
const { data }=await admin.from("agent_jobs").select("status,claimed_at,updated_at,log_tail").eq("workspace_id",WS).eq("spec_slug","spec-detail-timecard-timeline").eq("kind","build").order("created_at",{ascending:false}).limit(1);
const j=(data??[])[0] as any; console.log(`[${j?.status}] claimed=${j?.claimed_at} updated=${j?.updated_at}`);
console.log("log_tail:", String(j?.log_tail??"").split("\n").filter(Boolean).slice(-4).join(" | "));}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
