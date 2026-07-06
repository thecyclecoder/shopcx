/**
 * repair-verify-spec-persisted-before-build Phase 3 — re-drive swallowed real bugs.
 *
 * Detection query (VERBATIM from the spec intro): a `repair` `agent_jobs` row with
 * `instructions->>'authored_slug'` set AND `status='completed'` AND NO matching `public.specs` row.
 * Those 16 rows in the trailing 7 days are the "phantom-completed" repairs — the box authored a
 * fix spec, the write silently failed, the row still flipped to `completed`, and every real bug
 * behind them (dunning-shopify-pm-sync write failure, account_usage_snapshots numeric overflow to
 * bigint, change-next-billing-date route-through-Appstle, fraud-generate-summary Anthropic-529
 * handling, close-return silent-skip native returns …) sits swallowed with no fix + no surface.
 *
 * Phase 1 shipped `verify-after-author` at the source (a completed repair now can't slip past
 * with a missing spec). Phase 2 shipped the parked-router / claim-gate escalation backstop. This
 * script is Phase 3's ONE-SHOT hydrator: it finds every phantom-completed repair signature via
 * the SAME detection query the spec calls out, and:
 *
 *   dry-run (default) — prints each row + its signature/authored_slug/verdict/created_at so the
 *                       operator eyeballs the batch before touching anything.
 *   --apply           — for each row:
 *                         1) flip the phantom-completed repair to `needs_attention` (compare-and-
 *                            set: `.eq('workspace_id',…).eq('id',…).eq('status','completed').select
 *                            ('id')`, so an async-read result cannot overwrite a row that already
 *                            transitioned under us), with a NAMED error carrying the phantom slug
 *                            + reason; this surfaces it on `getOpenRepairs`;
 *                         2) stamp ONE `spec_row_missing_escalated` `director_activity` row per
 *                            hydrated repair, so Ada's feed carries the audit line;
 *                         3) enqueue a FRESH `repair` job for the SAME signature via
 *                            `enqueueRepairJob` (respects the LIVE-signature dedup — a live repair
 *                            for the same signature short-circuits — and the cluster cap). The
 *                            fresh run rides the Phase-1 verify-after-author + Phase-3 named-error
 *                            plumbing, so it either persists a spec OR surfaces a named author
 *                            error — never silently completes again.
 *
 * READ-ONLY by construction until `--apply`; NEVER mutates a repair row that's already surfaced
 * (needs_attention / needs_approval / failed / queued / claimed / building) — only completed
 * repairs whose fix spec silently vanished. Follows scripts/audit-* + scripts/backfill-* two-
 * phase idempotent conventions.
 */
import { createAdminClient } from "./_bootstrap";
import { enqueueRepairJob } from "../src/lib/repair-agent";
import { recordDirectorActivity } from "../src/lib/director-activity";

interface PhantomRepairRow {
  id: string;
  workspace_id: string;
  spec_slug: string | null;
  status: string;
  created_at: string;
  instructions: string | null;
}

interface ParsedInstr {
  signature?: string;
  source?: string;
  title?: string;
  authored_slug?: string;
  verdict?: string;
  error_event_id?: string | null;
}

async function findPhantomCompletedRepairs(admin: ReturnType<typeof createAdminClient>): Promise<Array<PhantomRepairRow & { instr: ParsedInstr }>> {
  const { data: rows } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, status, created_at, instructions")
    .eq("kind", "repair")
    .eq("status", "completed")
    .not("instructions", "is", null)
    .filter("instructions->>authored_slug", "not.is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  const candidates: Array<PhantomRepairRow & { instr: ParsedInstr }> = [];
  for (const row of ((rows ?? []) as PhantomRepairRow[])) {
    let instr: ParsedInstr = {};
    try {
      instr = row.instructions ? JSON.parse(row.instructions) : {};
    } catch {
      /* skip un-parseable instructions — nothing to re-drive from */
      continue;
    }
    const slug = instr.authored_slug;
    if (!slug) continue;
    const { data: existing } = await admin
      .from("specs")
      .select("slug")
      .eq("workspace_id", row.workspace_id)
      .eq("slug", slug)
      .maybeSingle();
    if (existing) continue; // spec row exists — NOT a phantom, skip
    candidates.push({ ...row, instr });
  }
  return candidates;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  console.log(`[re-drive-phantom-completed-repairs] scanning (dry-run=${!apply})…`);
  const phantoms = await findPhantomCompletedRepairs(admin);
  console.log(`[re-drive-phantom-completed-repairs] found ${phantoms.length} phantom-completed repair(s):`);
  for (const p of phantoms) {
    console.log(
      `  · job=${p.id.slice(0, 8)}  signature=${p.instr.signature ?? p.spec_slug}  authored_slug=${p.instr.authored_slug}  verdict=${p.instr.verdict ?? "(unknown)"}  created_at=${p.created_at}  title=${(p.instr.title ?? "").slice(0, 80)}`,
    );
  }
  if (!apply) {
    console.log(
      `[re-drive-phantom-completed-repairs] dry-run — nothing mutated. Re-run with --apply to hydrate + re-enqueue.`,
    );
    return;
  }
  if (!phantoms.length) {
    console.log(`[re-drive-phantom-completed-repairs] nothing to hydrate — exiting.`);
    return;
  }

  let flipped = 0;
  let reEnqueued = 0;
  for (const p of phantoms) {
    const signature = p.instr.signature ?? p.spec_slug ?? "";
    if (!signature) {
      console.warn(`[re-drive-phantom-completed-repairs] skipping ${p.id.slice(0, 8)} — no signature`);
      continue;
    }
    const named = `[repair-verify-spec-persisted-before-build P3] phantom-completed repair hydrated: the box authored [[${p.instr.authored_slug}]] but public.specs has no row — the fix spec silently vanished. Re-enqueued a fresh repair for signature ${signature}.`;

    // 1) Compare-and-set flip the phantom-completed row → needs_attention with the named error.
    //    Guarded on workspace_id + expected status='completed' + .select('id'), so an async race
    //    (someone re-opened it, someone else re-flipped it, a hotfix already re-drove) leaves the
    //    row alone and we skip the enqueue too — no double-drive.
    const { data: fl, error: flErr } = await admin
      .from("agent_jobs")
      .update({
        status: "needs_attention",
        error: named.slice(0, 2000),
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", p.workspace_id)
      .eq("id", p.id)
      .eq("status", "completed")
      .select("id");
    if (flErr) {
      console.warn(`[re-drive-phantom-completed-repairs] flip failed for ${p.id.slice(0, 8)}: ${flErr.message}`);
      continue;
    }
    if (!Array.isArray(fl) || fl.length === 0) {
      console.log(`[re-drive-phantom-completed-repairs] ${p.id.slice(0, 8)} already transitioned (compare-and-set 0 rows) — skipping re-enqueue`);
      continue;
    }
    flipped++;

    // 2) Audit line for Ada.
    await recordDirectorActivity(admin, {
      workspaceId: p.workspace_id,
      directorFunction: "platform",
      actionKind: "spec_row_missing_escalated",
      specSlug: p.instr.authored_slug ?? null,
      reason: named,
      metadata: {
        source: "redrive_script_phase3",
        prior_repair_status: "completed",
        repair_job_id: p.id,
        signature,
        authored_slug: p.instr.authored_slug,
        verdict: p.instr.verdict,
        autonomous: true,
      },
    });

    // 3) Re-enqueue a FRESH repair for the same signature. `enqueueRepairJob` short-circuits on a
    //    LIVE-signature dedup (any of queued/claimed/building/needs_input/needs_approval/queued_resume/
    //    needs_attention for the same signature), so this is idempotent under repeat runs and races.
    const r = await enqueueRepairJob(admin, {
      source: p.instr.source ?? "phantom-redrive",
      signature,
      title: p.instr.title ?? signature,
      errorEventId: p.instr.error_event_id ?? null,
    });
    if (r.enqueued) {
      reEnqueued++;
      console.log(`[re-drive-phantom-completed-repairs] ${p.id.slice(0, 8)} → hydrated + re-enqueued (signature=${signature})`);
    } else {
      console.log(`[re-drive-phantom-completed-repairs] ${p.id.slice(0, 8)} → hydrated; re-enqueue skipped (${r.reason})`);
    }
  }
  console.log(
    `[re-drive-phantom-completed-repairs] done — ${flipped} hydrated, ${reEnqueued} fresh repair job(s) enqueued (out of ${phantoms.length} candidate(s)).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
