import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "./../src/lib/supabase/admin";
import { getSpec } from "./../src/lib/brain-roadmap";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){const admin=createAdminClient();
 const spec=await getSpec("mario-reactive-box-agent", WS);
 if(!spec){console.log("no spec");return;}
 console.log("=== DERIVED card.phases (what queueNextChainedPhase sees) ===");
 for(const p of spec.card.phases as any[]) console.log(`  P${p.position ?? "?"} status=${p.status}  build_sha=${p.build_sha?String(p.build_sha).slice(0,8):"-"}  kind=${p.kind??"-"}  "${String(p.title).slice(0,50)}"`);
 const next=(spec.card.phases as any[]).find(p=>p.status==="planned");
 console.log(`\nnext planned phase → ${next?`P${next.position} "${next.title}"`:"NONE (chain thinks complete)"}`);
 if(next){
   // does a build job already exist with this phase's scoped instructions? (dedup guard)
   const { data:jobs }=await admin.from("agent_jobs").select("id,status,instructions").eq("workspace_id",WS).eq("spec_slug","mario-reactive-box-agent").eq("kind","build");
   const match=(jobs??[]).filter((j:any)=> (j.instructions??"").includes(next.title));
   console.log(`build jobs whose instructions mention "${next.title}": ${match.length} → ${match.map((m:any)=>m.status).join(",")}`);
   console.log(`(if ≥1, the dedup guard returns null and the chain never advances to a later phase)`);
 }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
