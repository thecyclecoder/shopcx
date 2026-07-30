import { loadEnv } from "./_bootstrap"; loadEnv();
import { evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
import { goalBranchState } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const disp = await evaluateGoalMemberBuildDispatch(WS,"bianca-cold-test-recent-purchaser-exclusion");
  console.log("dispatch verdict for recent-purchaser-exclusion:", JSON.stringify(disp));
  const st:any = await goalBranchState(WS,"bianca-temperature-aware-campaign-structure");
  console.log("\ngoalBranchState members (order matters — 'earliest ready' picked top-down):");
  for(const s of st.specs||[]) console.log(`  status=${String(s.status).padEnd(12)} onGoalBranch=${s.onGoalBranch} ${s.slug}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
