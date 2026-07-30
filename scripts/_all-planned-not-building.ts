import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { resolveGoalSlugForSpec } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACTIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage","needs_attention"];
(async()=>{
  const a=createAdminClient();
  const { data:specs }=await a.from("specs").select("slug,status,deferred,auto_build").eq("workspace_id",WS);
  const groups:Record<string,string[]>={};
  let scanned=0;
  for(const s of specs||[]){
    const st=(s as any).status;
    if(["folded","shipped","deferred"].includes(st)) continue;
    if((s as any).deferred) continue;
    const spec:any=await getSpec(WS,(s as any).slug).catch(()=>null);
    if(!spec) continue;
    const phases=spec.phases||[];
    if(phases.length>0 && phases.every((p:any)=>p.status==="shipped")) continue; // derived shipped
    const { data:bj }=await a.from("agent_jobs").select("status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",(s as any).slug).in("status",ACTIVE).limit(1);
    if((bj||[]).length) continue; // building/queued — not idle
    scanned++;
    const goal=await resolveGoalSlugForSpec(WS,(s as any).slug).catch(()=>null);
    const g=goal?(goal.includes("dahlia")?"dahlia-goal":goal.includes("bianca")?"bianca-goal":"goal:"+goal):"STANDALONE";
    const key=`${g} · auto_build=${(s as any).auto_build}`;
    (groups[key]??=[]).push((s as any).slug);
  }
  console.log(`planned/in-progress specs NOT building: ${scanned}\n`);
  for(const [k,v] of Object.entries(groups).sort()) console.log(`${k} (${v.length}):\n  - ${v.join("\n  - ")}\n`);
})().then(()=>process.exit(0));
