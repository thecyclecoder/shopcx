/**
 * _stamp-job-id-on-escalation-cards — one-time repair of OPEN escalation cards minted without a
 * `metadata.job_id`.
 *
 * WHY. `ceoEscalationNotification` silently dropped every caller's metadata (fixed 2026-08-11 — see
 * the doc on its `metadata` param). Cards already open still lack `job_id`, and without it they are
 * invisible to BOTH card-lifecycle mechanisms:
 *   - `activeParkCardExistsForJob` — the one-card-per-park dedupe, so siblings keep minting; and
 *   - `reconcileStaleParkCards` Family 1 — the job-backed auto-clear, INCLUDING its pr-resolve branch
 *     that dismisses a park card once its PR is MERGED or CLOSED.
 * A card for an already-merged PR is therefore structurally unclearable: Family 1 cannot see it, and
 * Family 1b refuses because the parked job is still `needs_attention`. Observed on `pr-2438` and
 * `pr-2450`, both merged, both still sitting in the founder's inbox with nothing he could do.
 *
 * The `job_id` was never lost — `recordDirectorActivity` received the same metadata and stored it.
 * This recovers it by matching on `dedupe_key`, which both surfaces share.
 *
 * Not a `_backfill-*.ts`: that prefix escalates an un-run data op to the CEO inbox, i.e. it would add
 * a card to the inbox this repairs. Run interactively with the founder present.
 *
 *   npx tsx scripts/_stamp-job-id-on-escalation-cards.ts            # dry run
 *   npx tsx scripts/_stamp-job-id-on-escalation-cards.ts --apply
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data: cardRows, error: cardErr } = await admin
    .from("dashboard_notifications")
    .select("id, title, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (cardErr) throw cardErr;

  const needsStamp = (cardRows ?? []).filter((c) => {
    const m = (c.metadata ?? {}) as Record<string, unknown>;
    if (typeof m["escalation_kind"] !== "string") return false; // routed Approval Requests are fine
    if (typeof m["job_id"] === "string" || typeof m["agent_job_id"] === "string") return false;
    return typeof m["dedupe_key"] === "string";
  });

  console.log(`${(cardRows ?? []).length} open cards · ${needsStamp.length} escalation card(s) missing job_id\n`);
  if (!needsStamp.length) {
    console.log("Nothing to stamp.");
    return;
  }

  // The ledger keyed by dedupe_key → job_id. `escalated` rows carry both.
  const { data: acts, error: actErr } = await admin
    .from("director_activity")
    .select("metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(4000);
  if (actErr) throw actErr;
  const jobByKey = new Map<string, string>();
  for (const a of (acts ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const m = a.metadata ?? {};
    const key = m["dedupe_key"];
    const job = m["job_id"];
    if (typeof key === "string" && typeof job === "string" && !jobByKey.has(key)) jobByKey.set(key, job);
  }

  let resolved = 0;
  let stamped = 0;
  for (const c of needsStamp) {
    const m = (c.metadata ?? {}) as Record<string, unknown>;
    const key = m["dedupe_key"] as string;
    const jobId = jobByKey.get(key);
    if (!jobId) {
      console.log(`  ${String(c.title).slice(0, 60)}\n      dedupe_key=${key} → no ledger row carries a job_id (skip)`);
      continue;
    }
    resolved++;
    console.log(`  ${String(c.title).slice(0, 60)}\n      dedupe_key=${key} → job_id=${jobId.slice(0, 8)}`);
    if (!APPLY) continue;
    // Merge, never replace — and re-assert dismissed=false so a card actioned since the read is skipped.
    const { error: upErr } = await admin
      .from("dashboard_notifications")
      .update({ metadata: { ...m, job_id: jobId, job_id_recovered_at: new Date().toISOString() } })
      .eq("id", c.id)
      .eq("dismissed", false);
    if (upErr) {
      console.warn(`      stamp failed: ${upErr.message}`);
      continue;
    }
    stamped++;
  }

  console.log(
    APPLY
      ? `\nAPPLIED — stamped ${stamped}/${resolved} resolvable card(s). reconcileStaleParkCards Family 1 can now evaluate them.`
      : `\nDRY RUN — ${resolved} of ${needsStamp.length} card(s) resolvable. Re-run with --apply.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
