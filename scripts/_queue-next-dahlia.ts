import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { goalBranchState, getSpec } from "../src/lib/specs-table";
import { evaluateGoalMemberBuildDispatch, enqueueBuildIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GOAL="dahlia-imitate-then-innovate-copy-engine";
const ACTIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage"];
(async()=>{
  const a=createAdminClient();
  const st:any=await goalBranchState(WS,GOAL);
  let queued=0;
  for(const m of st.specs||[]){
    if(m.onGoalBranch) continue;
    const disp:any=await evaluateGoalMemberBuildDispatch(WS,m.slug).catch(()=>({ok:false}));
    if(!disp.ok) continue;
    const { data:bj }=await a.from("agent_jobs").select("id").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",m.slug).in("status",ACTIVE).limit(1);
    if((bj||[]).length){ console.log(`${m.slug} already has an active build`); continue; }
    const s:any=await getSpec(WS,m.slug).catch(()=>null);
    if(s && (s.phases||[]).length>0 && (s.phases||[]).every((p:any)=>p.status==="shipped")) continue;
    const r=await enqueueBuildIfDue(WS,m.slug,{createdBy:null}).catch((e:any)=>({enqueued:false,reason:e.message}));
    console.log(`${m.slug}: ${(r as any).enqueued?"ENQUEUED ✅":"not enqueued ("+(r as any).reason+")"}`);
    if((r as any).enqueued) queued++;
  }
  console.log(`\nqueued ${queued} dahlia member(s)`);
})().then(()=>process.exit(0));
