import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
const { data:spec }=await admin.from("specs").select("id").eq("workspace_id",WS).eq("slug","mario-stall-detector-cron-and-thresholds").single();
const { data:ph }=await admin.from("spec_phases").select("position,status,pr,merge_sha").eq("spec_id",(spec as any).id).order("position");
for(const p of (ph??[]) as any[]) console.log(`  phase ${p.position}: ${p.status} pr=${p.pr??"-"}`);}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
