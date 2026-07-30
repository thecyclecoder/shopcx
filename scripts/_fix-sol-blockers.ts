import { loadEnv } from "./_bootstrap"; loadEnv();
import { setSpecBlockers } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PREFIX="sol-ticket-direction-then-cheap-execution:";
const FIX:[string,string[]][]=[
  ["sol-cheap-execution-over-ticket-direction",["sol-ticket-direction-artifact-and-first-touch-box-session"]],
  ["sol-drift-frustration-detector-and-re-session-router",["sol-cheap-execution-over-ticket-direction"]],
  ["sol-session-chosen-playbook-selection-retire-brittle-triggers",["sol-ticket-direction-artifact-and-first-touch-box-session"]],
  ["sol-cost-csat-measurement-vs-pre-sol-baseline",["sol-cheap-execution-over-ticket-direction","sol-drift-frustration-detector-and-re-session-router"]],
  ["sol-runaway-re-session-cap-guardrail",["sol-drift-frustration-detector-and-re-session-router"]],
];
(async()=>{
  for(const [slug,blockers] of FIX){
    await setSpecBlockers(WS, slug, blockers);
    console.log("✓ fixed blocked_by:", slug, "→", JSON.stringify(blockers));
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
