import { loadEnv } from "./_bootstrap";
loadEnv();
import { markSpecCardValePassed } from "../src/lib/spec-card-state";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
// M3/M4/M5 passed Vale (spec_review_passed in director_activity) but the legacy disposition path
// never stamped vale_review_passed_at, so the build claim-gate (claimHeldForUnreviewedSpec) re-queues
// them forever. Stamp the durable review-passed flag they earned, disposition=planned (matching the
// author-intent the legacy fallback already chose). markSpecCardValePassed re-fires build-eligible.
const SLUGS = [
  "mario-stall-detector-cron-and-thresholds",
  "mario-reactive-box-agent",
  "spec-detail-timecard-timeline",
];

async function main() {
  for (const slug of SLUGS) {
    await markSpecCardValePassed(
      WS,
      slug,
      { actor: "claude:pipeline-plumbing-live-fix", reason: "legacy-disposition passed Vale but did not stamp vale_review_passed_at; build stuck in claim-gate re-queue loop — stamping the earned review-passed flag" },
      { disposition: "planned", disposition_reason: "Vale passed (spec_review_passed recorded); build-eligible" },
    );
    console.log("stamped review-passed:", slug);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
