/**
 * One-off: clear the phantom `spec-review-sweep` needs_attention parks.
 *
 * Background — Ada (platform-director) re-escalated 3 parked `kind=spec-review`,
 * `spec_slug='spec-review-sweep'`, `error='spec-review produced no parseable decisions'`
 * jobs on every standing pass. Root cause: the sweep launched the review agent with ZERO
 * in_review specs, the agent returned no parseable decisions, and the job parked forever.
 * The code fix (runSpecReviewJob — no-op on a drained in_review pool) stops NEW phantoms;
 * this clears the EXISTING stuck rows so Ada stops re-escalating them.
 *
 * Dry-run by default; pass --apply to write. Scoped tightly to the exact phantom signature
 * so it can NEVER touch the pr-847 or loop:kpi_drift:escalations:daily parks (different
 * kind / spec_slug / error).
 *
 * Read-only / reversible: marks the jobs `dismissed` (status) +
 * needs_attention_class='dismissed_by_director' rather than deleting, so the CEO can re-open
 * from the activity feed if ever needed.
 */
import { createAdminClient } from "./_bootstrap";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  // ── 1. The phantom parks — tightly scoped signature ───────────────────────
  const { data: jobs, error: jErr } = await admin
    .from("agent_jobs")
    .select("id, kind, spec_slug, status, error, needs_attention_class, created_at")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("kind", "spec-review")
    .eq("spec_slug", "spec-review-sweep")
    .eq("status", "needs_attention")
    .eq("error", "spec-review produced no parseable decisions");
  if (jErr) throw jErr;

  console.log(`\nPhantom spec-review-sweep parks matched: ${jobs?.length ?? 0}`);
  for (const j of jobs ?? []) {
    console.log(`  • ${j.id}  class=${j.needs_attention_class ?? "(none)"}  created=${j.created_at}`);
  }

  // Safety: confirm we are NOT about to touch the protected parks.
  const { data: protectedJobs } = await admin
    .from("agent_jobs")
    .select("id, kind, spec_slug, status")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "needs_attention")
    .or("spec_slug.eq.pr-847,spec_slug.eq.loop:kpi_drift:escalations:daily");
  console.log(`\nProtected parks present (NOT touched): ${protectedJobs?.length ?? 0}`);
  for (const j of protectedJobs ?? []) console.log(`  • ${j.id}  spec_slug=${j.spec_slug}  kind=${j.kind}`);

  // ── 2. Matching dashboard notifications (best-effort) ──────────────────────
  // Scope ONLY to spec-review-sweep notifications (title carries the slug:
  // "Park needs eyes: spec-review-sweep" / "Parked spec-review: spec-review-sweep" /
  // "Parked > 70 min: spec-review-sweep"). A broad "Park needs eyes" match would wrongly
  // catch pr-847, director-loop-grading, etc. — so we require the slug in the title/body.
  const { data: notes, error: nErr } = await admin
    .from("dashboard_notifications")
    .select("id, title, body, dismissed, created_at")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("dismissed", false)
    .or("title.ilike.%spec-review-sweep%,body.ilike.%spec-review-sweep%");
  if (nErr) console.warn(`  (dashboard_notifications probe failed — table may differ: ${nErr.message})`);

  console.log(`\nMatching un-dismissed dashboard_notifications: ${notes?.length ?? 0}`);
  for (const n of notes ?? []) console.log(`  • ${n.id}  "${(n.title ?? "").slice(0, 60)}"`);

  if (!APPLY) {
    console.log(`\n[dry-run] No writes. Re-run with --apply to dismiss the above.\n`);
    return;
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  let clearedJobs = 0;
  for (const j of jobs ?? []) {
    const { error } = await admin
      .from("agent_jobs")
      .update({
        status: "dismissed",
        needs_attention_class: "dismissed_by_director",
        error: "phantom spec-review-sweep park (no in_review specs to review) — dismissed by one-off cleanup; sweep no-op fix shipped",
        updated_at: new Date().toISOString(),
      })
      .eq("id", j.id)
      .eq("workspace_id", WORKSPACE_ID); // belt-and-suspenders scope
    if (error) {
      console.error(`  ! failed to dismiss job ${j.id}: ${error.message}`);
    } else {
      clearedJobs++;
      console.log(`  ✓ dismissed job ${j.id}`);
    }
  }

  let clearedNotes = 0;
  for (const n of notes ?? []) {
    const { error } = await admin
      .from("dashboard_notifications")
      .update({ dismissed: true })
      .eq("id", n.id)
      .eq("workspace_id", WORKSPACE_ID);
    if (error) console.error(`  ! failed to dismiss notification ${n.id}: ${error.message}`);
    else {
      clearedNotes++;
      console.log(`  ✓ dismissed notification ${n.id}`);
    }
  }

  console.log(`\nDONE — dismissed ${clearedJobs} phantom job(s) + ${clearedNotes} notification(s).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
