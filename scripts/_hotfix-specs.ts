import { loadEnv } from "./_bootstrap"; loadEnv();
import { setSpecStatus } from "../src/lib/specs-table";
import { cancelJobsForArchivedSpecs, enqueueSpecTestIfDue } from "../src/lib/agent-jobs";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MOCK="media-buyer-agent-test-mock-support-neq-filter";
const DIGEST="media-buyer-digest-consolidate-product-names-suppress-noop";
(async()=>{
  // 1) Fold the obsolete mock-fix spec (its objective — test:media-buyer-agent green — is already met on main)
  await setSpecStatus(WS, MOCK, "folded", "ceo");
  console.log(`✓ folded ${MOCK}`);
  // 2) Cancel its stuck build job (now archived)
  const cancelled = await cancelJobsForArchivedSpecs({ workspaceId: WS });
  console.log(`✓ cancelJobsForArchivedSpecs: ${cancelled.cancelled} job(s) — slugs: ${cancelled.slugs.join(", ")||"(none)"}`);
  // 3) Re-run the digest spec's spec-test (test passes now → should go green + clear the stale fail)
  const res = await enqueueSpecTestIfDue(WS, DIGEST, "shipped");
  console.log(`✓ enqueueSpecTestIfDue(${DIGEST}): enqueued=${res.enqueued}${res.reason?` reason=${res.reason}`:""}`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,300));process.exit(1);});
