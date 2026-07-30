import { loadEnv } from "./_bootstrap"; loadEnv();
import { enqueueBuildIfDue, evaluateGoalMemberBuildDispatch } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const r=await enqueueBuildIfDue(WS,"dahlia-copy-author-box-session",{createdBy:"ceo:dylan"});
  console.log("enqueue head:", JSON.stringify(r));
  // re-check dispatch for both head + dahlia-deeper
  console.log("dispatch(head):", JSON.stringify(await evaluateGoalMemberBuildDispatch(WS,"dahlia-copy-author-box-session")));
  console.log("dispatch(deeper):", JSON.stringify(await evaluateGoalMemberBuildDispatch(WS,"dahlia-deeper-competitor-selection")));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)});
