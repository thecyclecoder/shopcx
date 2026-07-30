import { loadEnv } from "./_bootstrap"; loadEnv();
import { markSpecCardBackToReview } from "../src/lib/spec-card-state";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  for(const slug of ["ticket-analyzer-becomes-box-agent-under-june","prompt-auto-review-becomes-box-agent-under-june","sonnet-prompts-sdk-for-review-agent-db-access"]){
    await markSpecCardBackToReview(WS, slug, { actor: "ceo", reason: "parent re-anchored to a real cs mandate — bare-function-parent defect fixed" });
    console.log("✓ re-review queued:", slug);
  }
  process.exit(0);
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});
