/**
 * One-off ops cleanup: reap needs_attention build/spec-test jobs whose spec is already
 * ARCHIVED (folded/deferred) — the exact gap cancelJobsForArchivedSpecs misses because
 * needs_attention is not in ACTIVE_STATUSES. Mirrors that helper's update shape/reason.
 * These jobs are superseded (the spec shipped+folded), so cancelling them just stops Ada's
 * stuck-detector from re-flagging shipped specs. Dry by default; APPLY=1 to cancel.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listSpecs } from "../src/lib/specs-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.env.APPLY === "1";

async function main() {
  const admin = createAdminClient();
  const { data: jobs } = await admin.from("agent_jobs")
    .select("id, spec_slug, kind, updated_at")
    .eq("workspace_id", WS).eq("status", "needs_attention").in("kind", ["build", "spec-test"]);
  const slugs = [...new Set((jobs || []).map((j: any) => j.spec_slug).filter(Boolean))];
  const [folded, deferred] = await Promise.all([
    listSpecs(WS, { status: "folded" }), listSpecs(WS, { status: "deferred" }),
  ]);
  const archived = new Set([...folded.map((s: any) => s.slug), ...deferred.map((s: any) => s.slug)]);
  const targets = (jobs || []).filter((j: any) => j.spec_slug && archived.has(j.spec_slug));

  console.log(`needs_attention build/spec-test jobs: ${jobs?.length ?? 0} · archived-spec (reapable): ${targets.length}`);
  for (const j of targets) console.log(`   REAP [${j.kind}] ${j.spec_slug}  (job ${j.id}, parked ${j.updated_at})`);

  if (!APPLY) { console.log("\nDRY RUN — set APPLY=1 to cancel these superseded jobs."); return; }

  const reason = "spec archived — needs_attention build superseded (spec folded/shipped; parked job reaped)";
  let n = 0;
  for (const j of targets) {
    const { error } = await admin.from("agent_jobs")
      .update({ status: "completed", error: reason, questions: [], pending_actions: [], updated_at: new Date().toISOString() })
      .eq("id", j.id);
    if (!error) n++;
  }
  console.log(`\ncancelled ${n} superseded job(s).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
