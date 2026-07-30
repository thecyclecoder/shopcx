import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
 // spec phases (M4 has 5 phases: kind-wiring, runMarioJob, SKILL, applyBoxMario, identity)
 const { data:spec }=await admin.from("specs").select("id").eq("workspace_id",WS).eq("slug","mario-reactive-box-agent").single();
 const { data:ph }=await admin.from("spec_phases").select("position,title,status,build_sha,pr,merge_sha").eq("spec_id",(spec as any).id).order("position");
 console.log("=== M4 phases ===");
 for(const p of (ph??[]) as any[]) console.log(`  P${p.position} [${p.status}] build_sha=${p.build_sha?String(p.build_sha).slice(0,8):"-"}  ${String(p.title).slice(0,60)}`);
 // live build job
 const { data:jobs }=await admin.from("agent_jobs").select("id,status,session_note,session_checklist,claimed_at,last_heartbeat_at,pr_url,log_tail").eq("workspace_id",WS).eq("spec_slug","mario-reactive-box-agent").eq("kind","build").order("created_at",{ascending:false}).limit(1);
 const j=(jobs??[])[0] as any;
 const now=Date.now();
 console.log(`\n=== M4 live build [${j?.status}] ===`);
 console.log(`  claimed ${j?.claimed_at?Math.round((now-new Date(j.claimed_at).getTime())/60000)+"min":"-"} ago  hb ${j?.last_heartbeat_at?Math.round((now-new Date(j.last_heartbeat_at).getTime())/1000)+"s":"-"} ago  pr=${j?.pr_url??"-"}`);
 console.log(`  session_note: ${j?.session_note??"-"}`);
 const chk=(j?.session_checklist??[]) as {step:string;status:string}[];
 if(chk.length){console.log("  checklist:");for(const c of chk) console.log(`    [${c.status}] ${c.step}`);}
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
