/**
 * requeue-failed-builds — recover builds that failed because the box's Max account hit the usage wall.
 *
 * Nothing was lost: the spec markdown is committed and a build is idempotent (re-reads the spec, writes
 * code fresh). This flips eligible `failed` jobs back to `queued` so the box re-runs them. Run it once
 * the box account has tokens again (≈4pm), or anytime: `npx tsx scripts/requeue-failed-builds.ts`.
 *
 * Only re-queues build / spec-test / fold jobs whose spec still has UNBUILT phases (skips ones already
 * shipped/superseded, and one-off kinds like pr-resolve/spec-chat). De-dupes against any in-flight job.
 */
import { loadEnv, createAdminClient } from "./_bootstrap";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const REQUEUE_KINDS = new Set(["build", "spec-test", "fold"]);
const ACTIVE = ["queued", "claimed", "building", "queued_resume", "needs_input", "needs_approval"];

(async () => {
  loadEnv();
  const a = createAdminClient();
  const { data: failed } = await a
    .from("agent_jobs")
    .select("id, kind, spec_slug, updated_at")
    .eq("workspace_id", WS)
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(100);

  let requeued = 0;
  const skipped: string[] = [];
  for (const j of (failed ?? []) as Array<Record<string, string>>) {
    if (!REQUEUE_KINDS.has(j.kind)) { skipped.push(`${j.spec_slug}(${j.kind}: one-off)`); continue; }
    // skip if a fresh job for the same spec+kind is already in flight (a retry already happened)
    const { data: live } = await a
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", WS)
      .eq("kind", j.kind)
      .eq("spec_slug", j.spec_slug)
      .in("status", ACTIVE)
      .limit(1);
    if (live && live.length) { skipped.push(`${j.spec_slug}(${j.kind}: already in flight)`); continue; }
    await a.from("agent_jobs").update({ status: "queued", error: null, claimed_at: null }).eq("id", j.id);
    requeued++;
    console.log(`  ↻ re-queued ${j.kind} ${j.spec_slug}`);
  }
  console.log(`\nre-queued ${requeued} job(s); skipped ${skipped.length}: ${skipped.join(", ") || "none"}`);
})().catch((e) => console.error("ERR:", e instanceof Error ? e.message.slice(0, 160) : e));
