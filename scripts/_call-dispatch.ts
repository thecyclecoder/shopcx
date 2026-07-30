import { loadEnv } from "./_bootstrap"; loadEnv();
import { evaluateGoalMemberBuildDispatch, decideGoalMemberEnqueueAdmission } from "../src/lib/agent-jobs";
import { goalBranchState } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const disp:any=await evaluateGoalMemberBuildDispatch(WS, "dahlia-deeper-competitor-selection");
  console.log("dispatch(dahlia-deeper):", JSON.stringify(disp));
  const adm:any=await decideGoalMemberEnqueueAdmission?.(WS, "dahlia-deeper-competitor-selection").catch((e:any)=>({err:e.message}));
  console.log("admission(dahlia-deeper):", JSON.stringify(adm));
  const st:any=await goalBranchState(WS, "dahlia-imitate-then-innovate-copy-engine");
  console.log("\n=== goalBranchState members (slug | derivedStatus | blocked_by) ===");
  for(const s of st.specs||[]) console.log(`  ${(s.derivedStatus||s.status||"?").padEnd(12)} blk=${JSON.stringify(s.blocked_by||s.blockedBy||[])} ${s.slug}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",e.message);process.exit(1)});
