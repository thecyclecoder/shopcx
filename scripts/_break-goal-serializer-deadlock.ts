import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
// Goal-member serialization deadlock: M3 + M5 were claimed ~200ms apart, each saw the other as
// in-flight and self-held, and they re-race every cooldown cycle so neither builds. Break the tie:
// release M3 (claimed_at=null → claimed next poll) and park M5 15min (claimed_at future) so exactly
// ONE goal-member is claimable. M3 builds alone; when M5's park lapses the serializer correctly holds
// it behind M3 (or lets it run once M3 is done). Reversible: only mutates agent_jobs.claimed_at.
async function main() {
  const admin = createAdminClient();
  const release = "mario-stall-detector-cron-and-thresholds"; // M3 — unblocks M4, run first
  const park = "spec-detail-timecard-timeline"; // M5 — leaf, park briefly

  const { data: r } = await admin
    .from("agent_jobs")
    .update({ claimed_at: null, updated_at: new Date().toISOString(), log_tail: "deadlock-break: released as the single goal-member to build; sibling parked to avoid the same-tick claim race" })
    .eq("workspace_id", WS).eq("spec_slug", release).eq("kind", "build").eq("status", "queued")
    .select("id");
  console.log(`released ${release}:`, (r ?? []).map((x: { id: string }) => x.id.slice(0, 8)));

  const parkUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { data: p } = await admin
    .from("agent_jobs")
    .update({ claimed_at: parkUntil, updated_at: new Date().toISOString(), log_tail: "deadlock-break: parked 15min so the sibling goal-member builds alone (serializer race avoidance)" })
    .eq("workspace_id", WS).eq("spec_slug", park).eq("kind", "build").eq("status", "queued")
    .select("id");
  console.log(`parked ${park} until ${parkUntil}:`, (p ?? []).map((x: { id: string }) => x.id.slice(0, 8)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
