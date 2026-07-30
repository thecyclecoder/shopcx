import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { queueNextChainedPhase, ACTIVE_STATUSES } from "../src/lib/agent-jobs";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "mario-reactive-box-agent";

// Live fix: the pre-merge fix phase (P6) was appended but its resumed build was never queued —
// queueNextChainedPhase bailed on its in-flight guard because it was called WHILE the spec-test
// session was still active, and nothing re-fired it after. No active build now, so re-firing the
// sanctioned chain enqueue inserts the P6 resumed build. Reversible (a single agent_jobs build row).
async function main() {
  const admin = createAdminClient();
  const { data: active } = await admin
    .from("agent_jobs")
    .select("id,status")
    .eq("workspace_id", WS).eq("spec_slug", SLUG).eq("kind", "build")
    .in("status", ACTIVE_STATUSES);
  if (active && active.length) {
    console.log("ABORT — an M4 build is still active; would just no-op:", active.map((a: { status: string }) => a.status));
    return;
  }
  const queued = await queueNextChainedPhase(WS, SLUG);
  console.log(queued ? `queued resumed build for next phase → "${queued}"` : "queueNextChainedPhase returned null (no planned phase, dedup, or in-flight)");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
