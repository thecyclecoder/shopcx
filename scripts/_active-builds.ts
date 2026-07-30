import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
const { data } = await admin.from("agent_jobs").select("spec_slug,status,claimed_at,last_heartbeat_at,session_note").eq("workspace_id",WS).eq("kind","build").eq("status","building").order("claimed_at",{ascending:true});
const now=Date.now();
for(const j of (data??[]) as any[]){const age=j.claimed_at?Math.round((now-new Date(j.claimed_at).getTime())/60000):"?";const hb=j.last_heartbeat_at?Math.round((now-new Date(j.last_heartbeat_at).getTime())/1000):"?";console.log(`  ${j.spec_slug}\n     building ${age}min  hb ${hb}s ago  :: ${j.session_note??""}`);}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
