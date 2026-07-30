import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUGS = ["mario-stall-detector-cron-and-thresholds", "spec-detail-timecard-timeline"];

async function main() {
  const admin = createAdminClient();
  for (const slug of SLUGS) {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("id, kind, status, created_at, claimed_at, updated_at, last_heartbeat_at, reap_count, needs_attention_class, error, log_tail, claude_session_id")
      .eq("workspace_id", WS)
      .eq("spec_slug", slug)
      .eq("kind", "build")
      .order("created_at", { ascending: false })
      .limit(4);
    console.log(`\n================ ${slug} ================`);
    for (const j of (jobs ?? []) as Record<string, unknown>[]) {
      console.log(`\n  job ${String(j.id).slice(0, 8)} [${j.status}] reap=${j.reap_count ?? 0} class=${j.needs_attention_class ?? "-"} session=${j.claude_session_id ? "set" : "-"}`);
      console.log(`    created=${j.created_at}  claimed=${j.claimed_at ?? "-"}  updated=${j.updated_at}  hb=${j.last_heartbeat_at ?? "-"}`);
      if (j.error) console.log(`    ERROR: ${String(j.error).slice(0, 300)}`);
      const tail = String(j.log_tail ?? "").split("\n").filter(Boolean).slice(-10).join("\n      ");
      if (tail.trim()) console.log(`    log_tail:\n      ${tail}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
