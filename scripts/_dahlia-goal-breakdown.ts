import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { goalBranchState, getSpec } from "../src/lib/specs-table";
import { evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const GOAL="dahlia-imitate-then-innovate-copy-engine";
const ACTIVE=["queued","claimed","building","needs_input","needs_approval","queued_resume","blocked_on_usage"];
(async()=>{
  const a=createAdminClient();
  const st:any=await goalBranchState(WS,GOAL);
  const members=st.specs||[];
  console.log(`goal has ${members.length} members\n`);
  const buckets:Record<string,string[]>={onBranch:[],building:[],queued:[],needs_attention:[],blocked:[],planned_no_job:[]};
  for(const m of members){
    if(m.onGoalBranch){ buckets.onBranch.push(m.slug); continue; }
    const spec:any=await getSpec(WS,m.slug).catch(()=>null);
    const { data:bj }=await a.from("agent_jobs").select("status,needs_attention_class").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",m.slug).in("status",ACTIVE.concat(["needs_attention"])).order("updated_at",{ascending:false}).limit(1);
    const job=(bj as any)?.[0];
    const blockers=(spec?.blocked_by||[]);
    if(job?.status==="building"||job?.status==="claimed") buckets.building.push(m.slug);
    else if(job?.status==="needs_attention") buckets.needs_attention.push(`${m.slug}(${job.needs_attention_class||"?"})`);
    else if(job && ACTIVE.includes(job.status)) buckets.queued.push(`${m.slug}(${job.status})`);
    else if(blockers.length){ const disp:any=await evaluateGoalMemberBuildDispatch(WS,m.slug).catch(()=>({ok:false})); buckets.blocked.push(`${m.slug}[bb:${blockers.join(",")}]`); }
    else buckets.planned_no_job.push(m.slug);
  }
  for(const [k,v] of Object.entries(buckets)) console.log(`${k} (${v.length}):${v.length?"\n  - "+v.join("\n  - "):""}`);
})().then(()=>process.exit(0));
