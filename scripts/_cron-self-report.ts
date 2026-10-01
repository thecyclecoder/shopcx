/** Did the subsystem report on itself, without anyone asking? */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin=createAdminClient();
  // 1. did the reconcile cron actually run, and what did it produce?
  const {data:hb}=await admin.from("loop_heartbeats").select("*")
    .eq("loop_id","shopcx-drift-reconcile-cron").order("created_at",{ascending:false}).limit(3);
  if(!hb?.length){
    const {data:any1}=await admin.from("loop_heartbeats").select("loop_id,created_at").order("created_at",{ascending:false}).limit(3);
    console.log("no heartbeat rows for the drift cron. most recent beats on the box:",JSON.stringify(any1));
  } else {
    console.log("drift cron heartbeats (most recent first):");
    for(const h of hb) console.log(`  ${String((h as any).created_at).slice(0,16)}  ${JSON.stringify((h as any).produced ?? (h as any).payload ?? {})}`);
  }
  // 2. did it ESCALATE — i.e. is there a repair job it opened?
  const {data:jobs}=await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,title,created_at")
    .eq("kind","repair").ilike("spec_slug","%shopcx-subscription-health%").order("created_at",{ascending:false}).limit(5);
  console.log(`\nrepair jobs opened by the subsystem: ${jobs?.length ?? 0}`);
  for(const j of jobs??[]) console.log(`  ${String(j.created_at).slice(0,16)}  ${j.status}  ${j.title}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR",e.message);process.exit(1);});
