import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { goalBranchState } from "../src/lib/specs-table";
import { evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const st:any=await goalBranchState(WS,"bianca-temperature-aware-campaign-structure").catch((e:any)=>({err:e.message}));
  if(st.err){ console.log("goalBranchState err:", st.err); }
  else {
    console.log("goal members (onGoalBranch = integrated):");
    for(const m of st.specs||[]){
      const disp:any=await evaluateGoalMemberBuildDispatch(WS,m.slug).catch((e:any)=>({ok:false,reason:e.message}));
      // active build job?
      const { data:bj }=await a.from("agent_jobs").select("status,needs_attention_class").eq("workspace_id",WS).eq("kind","build").eq("spec_slug",m.slug).in("status",["queued","claimed","building","needs_attention","needs_approval","needs_input","queued_resume"]).order("updated_at",{ascending:false}).limit(1);
      const job=(bj as any)?.[0];
      console.log(`  ${m.slug}: onBranch=${m.onGoalBranch} status=${m.status} | dispatch=${disp.ok?"OK":"HELD: "+(disp.reason||"").slice(0,60)} | job=${job?job.status+(job.needs_attention_class?"/"+job.needs_attention_class:""):"none"}`);
    }
  }
})().then(()=>process.exit(0));
