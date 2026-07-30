import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
import { getSpecBlockers } from "./../src/lib/brain-roadmap";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
 const { data:g } = await admin.from("goals").select("id,slug,status,main_merge_sha,is_parent").eq("workspace_id",WS).eq("slug","mario-pipeline-plumbing").single();
 console.log("GOAL:",JSON.stringify(g));
 const { data:specs } = await admin.from("specs").select("slug,goal_branch_sha,goal_id,milestone_id,auto_build").eq("workspace_id",WS).in("slug",["spec-timecard-ledger-and-sdk","spec-timecard-chokepoint-instrumentation","mario-stall-detector-cron-and-thresholds","spec-detail-timecard-timeline"]);
 for(const s of (specs??[]) as any[]) console.log(`  ${s.slug}: goal_branch_sha=${s.goal_branch_sha?String(s.goal_branch_sha).slice(0,8):"-"} goal_id=${s.goal_id?"set":"-"} auto_build=${s.auto_build}`);
 for(const slug of ["mario-stall-detector-cron-and-thresholds","spec-detail-timecard-timeline"]){
   try{ const b=await getSpecBlockers(WS,slug); console.log(`\nblockers(${slug}):`,JSON.stringify(b));}catch(e:any){console.log(`blockers(${slug}) ERR`,e.message);}
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
