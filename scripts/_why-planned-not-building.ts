import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec, resolveGoalSlugForSpec as _ } from "../src/lib/specs-table";
import { enqueueBuildIfDue, resolveGoalSlugForSpec } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACTIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage","needs_attention"];
(async()=>{
  const a=createAdminClient();
  // candidate specs: auto_build true, not folded/deferred/shipped-derived, no active build
  const { data:specs }=await a.from("specs").select("slug,status,deferred,auto_build,blocked_by").eq("workspace_id",WS).eq("auto_build",true);
  const rows:any[]=[];
  for(const s of specs||[]){
    if((s as any).deferred) continue;
    if(["folded","deferred","shipped"].includes((s as any).status)) continue;
    const spec:any=await getSpec(WS,(s as any).slug).catch(()=>null);
    if(!spec) continue;
    const phases=spec.phases||[];
    const derivedShipped=phases.length>0 && phases.every((p:any)=>p.status==="shipped");
    if(derivedShipped) continue;
    // active build?
    const { data:bj }=await a.from("agent_jobs").select("status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",(s as any).slug).in("status",ACTIVE).limit(1);
    if((bj||[]).length) continue; // already has a job
    // not building — why?
    const goal=await resolveGoalSlugForSpec(WS,(s as any).slug).catch(()=>null);
    if(goal && (goal.includes("dahlia")||goal.includes("bianca"))) continue; // skip the two goals we know
    const r:any=await enqueueBuildIfDue(WS,(s as any).slug,{createdBy:null,dryRun:true} as any).catch((e:any)=>({enqueued:false,reason:e.message}));
    rows.push({slug:(s as any).slug, goal:goal||"(standalone)", blocked_by:(spec.blocked_by||[]).join(",")||"-", reason:r.reason||(r.enqueued?"WOULD ENQUEUE":"?")});
  }
  console.log(`buildable-but-not-building candidates (excl dahlia/bianca goals): ${rows.length}\n`);
  for(const r of rows) console.log(`  ${r.slug}\n     goal=${r.goal} bb=[${r.blocked_by}] → ${r.reason}`);
})().then(()=>process.exit(0));
