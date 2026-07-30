import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  // Global build-lane occupancy
  const { data:active } = await admin.from("agent_jobs").select("kind,status").eq("workspace_id",WS).in("status",["building","claimed"]);
  const byKind:Record<string,number>={};
  for(const j of (active??[]) as any[]) byKind[`${j.kind}:${j.status}`]=(byKind[`${j.kind}:${j.status}`]||0)+1;
  console.log("ACTIVE (building/claimed) by kind:", JSON.stringify(byKind,null,0));
  // blocked_on_usage / needs_attention counts
  const { data:parked } = await admin.from("agent_jobs").select("status").eq("workspace_id",WS).in("status",["blocked_on_usage","blocked_on_dependency","needs_approval","queued","queued_resume"]);
  const p:Record<string,number>={};
  for(const j of (parked??[]) as any[]) p[j.status]=(p[j.status]||0)+1;
  console.log("PARKED/QUEUED counts:", JSON.stringify(p));
  // M3/M5 queued age + claimed_at
  const { data:mine } = await admin.from("agent_jobs").select("spec_slug,kind,status,created_at,claimed_at,last_heartbeat_at").eq("workspace_id",WS).in("spec_slug",["mario-stall-detector-cron-and-thresholds","spec-detail-timecard-timeline"]).eq("kind","build").order("created_at",{ascending:false});
  const now=Date.now();
  console.log("\nMy queued builds:");
  for(const j of (mine??[]) as any[]){
    const age=Math.round((now-new Date(j.created_at).getTime())/60000);
    console.log(`  ${j.spec_slug} [${j.status}] queued ${age}min ago  claimed_at=${j.claimed_at??"-"}`);
  }
  // worker heartbeat: any job with a recent heartbeat = worker alive
  const { data:hb } = await admin.from("agent_jobs").select("last_heartbeat_at").eq("workspace_id",WS).not("last_heartbeat_at","is",null).order("last_heartbeat_at",{ascending:false}).limit(1);
  const last=(hb?.[0] as any)?.last_heartbeat_at;
  console.log(`\nMost recent worker heartbeat: ${last} (${last?Math.round((now-new Date(last).getTime())/1000)+"s ago":"none"})`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
