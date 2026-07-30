import { loadEnv } from "./_bootstrap"; loadEnv();
import { setSpecParent } from "../src/lib/specs-table";
import { markSpecCardBackToReview } from "../src/lib/spec-card-state";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FIX:[string,string,string][]=[
  ["ticket-analyzer-becomes-box-agent-under-june",
   '[[../functions/cs]] — "Escalation triage quality" mandate: the AI quality analyzer that decides reopen/escalate must be a supervised box-session agent in June (CS Director)\'s charge with a typed SDK for its DB access, not a headless Sonnet API cron writing raw table calls.',
   "cs#escalation-triage"],
  ["prompt-auto-review-becomes-box-agent-under-june",
   '[[../functions/cs]] — "Fix weird tickets fast, calibrate so they don\'t recur" mandate: the conversation-rule auto-reviewer must be a supervised box-session agent in June (CS Director)\'s charge, not a headless Opus API cron optimizing a proxy with no objective-owner.',
   "cs#calibrate"],
  ["sonnet-prompts-sdk-for-review-agent-db-access",
   '[[../functions/cs]] — "Fix weird tickets fast, calibrate so they don\'t recur" mandate: writes to sonnet_prompts (review decisions, status, auto_decision) go through one typed SDK, not raw table calls, so review state is auditable and drift-proof.',
   "cs#calibrate"],
];
(async () => {
  for(const [slug,parent,ref] of FIX){
    await setSpecParent(WS, slug, { parent, parentKind: "mandate", parentRef: ref });
    await markSpecCardBackToReview(WS, slug).catch((e:any)=>console.log("  reReview note:",e.message?.slice(0,60)));
    console.log("✓ fixed +re-review:", slug);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
