import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
 // worker heartbeat / running sha
 const { data:wc }=await admin.from("worker_controls").select("box_id,running_sha,last_heartbeat_at,drain_for_update").limit(5);
 const now=Date.now();
 for(const w of (wc??[]) as any[]) console.log(`box ${w.box_id}: sha=${w.running_sha?String(w.running_sha).slice(0,8):"-"} hb=${w.last_heartbeat_at?Math.round((now-new Date(w.last_heartbeat_at).getTime())/1000)+"s":"-"} drain=${w.drain_for_update}`);
 // any mario jobs enqueued yet?
 const { data:mj }=await admin.from("agent_jobs").select("id,status,spec_slug,created_at").eq("kind","mario").order("created_at",{ascending:false}).limit(5);
 console.log(`\nkind='mario' jobs: ${(mj??[]).length}`);
 for(const j of (mj??[]) as any[]) console.log(`  [${j.status}] ${j.spec_slug} ${j.created_at}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
