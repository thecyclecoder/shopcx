/**
 * repair-author-write-surface-real-error-not-swallow Phase 3 — operational re-drive.
 *
 * Re-drives the FOUR parked repair signatures the prior spec
 * (`repair-verify-spec-persisted-before-build`) escalated to `needs_attention` with the GENERIC
 * "silent author-write fallout" error string, now that Phase 1 + Phase 2 of this spec have closed
 * the swallow at the author chokepoint. After a fresh re-drive against the fixed code each of these
 * signatures either lands a real `public.specs` row OR parks a `needs_attention` repair carrying a
 * CONCRETE DB/author error string (never the generic fallout again), which is the Phase-3
 * verification.
 *
 * ── Target signatures (from spec Phase 3) ──
 *
 *   1. auth-listusers-hot-path-scan-fix — a real `auth.users` full-table-scan fix; leading suspect
 *      behind the open db_health cache-pressure escalation. PRIORITIZED first.
 *   2. box-worker-self-update-anchor-boot-sha — box worker self-update anchor / boot SHA issue.
 *   3. error-feed-scope-supabase-auth-dial-io-timeout-transient — dial-IO timeout transient.
 *   4. error-feed-drop-supabase-gotrue-504-edge-noise — gotrue 504 edge noise.
 *
 * ── Why THIS script and not `_redrive-phantom-completed-repairs.ts` (the prior spec's tool) ──
 *
 * The prior script targets `status='completed'` repairs whose `authored_slug` never materialized in
 * `public.specs` — the PHANTOM COMPLETION shape. The 4 signatures here were caught LATER, by the
 * verify-after-author backstop (scripts/builder-worker.ts:14335-14364) which now parks such repairs
 * as `needs_attention`, not `completed`. Because `needs_attention` sits in `LIVE_REPAIR_STATUSES`
 * (src/lib/repair-agent.ts:122), `enqueueRepairJob`'s dedup would short-circuit a naive re-enqueue —
 * so we MUST resolve the parked repair first, then enqueue fresh. Two-step, compare-and-set on both.
 *
 * ── Operator flow (matches scripts/audit-* / scripts/backfill-* / scripts/_redrive-*.ts convention) ──
 *
 *   dry-run (default)  — prints, per signature, the parked repair(s) it would resolve + whether an
 *                        enqueue would fire (or is skipped because a public.specs row already exists).
 *   --apply            — for each of the 4 signatures:
 *                          1) look up any LIVE repair job (any of LIVE_REPAIR_STATUSES) whose
 *                             `spec_slug` = signature;
 *                          2) if found, compare-and-set flip it to `completed` with a re-drive note
 *                             (`.eq('workspace_id',…).eq('id',…).in('status', LIVE_REPAIR_STATUSES)
 *                             .select('id')` — the read-time preconditions are re-asserted at the
 *                             write, so an async race that already re-drove or someone else
 *                             re-opened cannot get overwritten, per the coaching mandate on
 *                             compare-and-set guards);
 *                          3) record one `spec_row_missing_escalated` `director_activity` row per
 *                             re-drive so Ada's platform-director feed carries the audit line;
 *                          4) call `enqueueRepairJob` for the SAME signature — a fresh diagnosis
 *                             rides the Phase-1 + Phase-2 fixed code, so it either persists a spec
 *                             OR surfaces a NAMED author error (never the generic fallout again).
 *
 * READ-ONLY by construction until `--apply`. Idempotent under re-runs: if the parked repair already
 * transitioned (a hotfix, an operator dismiss, a prior re-drive), the compare-and-set flip returns
 * zero rows and we skip the enqueue for that signature. If a fresh repair job is already live
 * (`enqueueRepairJob` short-circuits), the script logs and moves on. If `public.specs` already
 * carries a row for the fix slug (e.g. Phase 2's read-after-write already caught it or a prior
 * manual author landed the spec), the signature is a no-op.
 *
 * See docs/brain/specs/repair-author-write-surface-real-error-not-swallow.md § Phase 3.
 */
import { createAdminClient } from "./_bootstrap";
import { enqueueRepairJob } from "../src/lib/repair-agent";
import { recordDirectorActivity } from "../src/lib/director-activity";

// The 4 signatures the spec lists. `auth-listusers-hot-path-scan-fix` FIRST — the leading suspect
// behind the open db_health cache-pressure escalation, per the spec note (Phase 3 line).
const TARGET_SIGNATURES = [
  "auth-listusers-hot-path-scan-fix",
  "box-worker-self-update-anchor-boot-sha",
  "error-feed-scope-supabase-auth-dial-io-timeout-transient",
  "error-feed-drop-supabase-gotrue-504-edge-noise",
] as const;

// Mirror of `src/lib/repair-agent.ts:122` `LIVE_REPAIR_STATUSES`. Inlined so this script never has
// to import the constant + risk a drift — the same status list `enqueueRepairJob` dedups against.
const LIVE_REPAIR_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "needs_attention",
] as const;

interface ParkedRepair {
  id: string;
  workspace_id: string;
  spec_slug: string;
  status: string;
  error: string | null;
  created_at: string;
  instructions: string | null;
}

interface SignatureReport {
  signature: string;
  parked: ParkedRepair[];
  existingSpec: { slug: string } | null;
}

async function findParkedForSignature(
  admin: ReturnType<typeof createAdminClient>,
  signature: string,
): Promise<ParkedRepair[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, status, error, created_at, instructions")
    .eq("kind", "repair")
    .eq("spec_slug", signature)
    .in("status", LIVE_REPAIR_STATUSES as unknown as string[])
    .order("created_at", { ascending: false });
  return ((data ?? []) as ParkedRepair[]).filter((r) => !!r.id);
}

// A signature might have already re-driven successfully — if `public.specs` carries a row named for
// the fix slug (extracted from the parked repair's instructions), we treat that as "done" and skip.
async function findExistingFixSpecForRepair(
  admin: ReturnType<typeof createAdminClient>,
  repair: ParkedRepair | null,
): Promise<{ slug: string } | null> {
  if (!repair) return null;
  let authoredSlug: string | null = null;
  try {
    const instr = repair.instructions ? JSON.parse(repair.instructions) : {};
    authoredSlug = typeof instr.authored_slug === "string" ? instr.authored_slug : null;
  } catch {
    /* not JSON — no authored_slug to look up */
  }
  if (!authoredSlug) return null;
  const { data } = await admin
    .from("specs")
    .select("slug")
    .eq("workspace_id", repair.workspace_id)
    .eq("slug", authoredSlug)
    .maybeSingle();
  if (data && (data as { slug?: string }).slug) return { slug: (data as { slug: string }).slug };
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  console.log(`[redrive-4-parked] scanning (dry-run=${!apply})…`);
  const reports: SignatureReport[] = [];
  for (const signature of TARGET_SIGNATURES) {
    const parked = await findParkedForSignature(admin, signature);
    const existingSpec = await findExistingFixSpecForRepair(admin, parked[0] ?? null);
    reports.push({ signature, parked, existingSpec });
  }

  console.log(`[redrive-4-parked] plan:`);
  for (const r of reports) {
    if (r.existingSpec) {
      console.log(
        `  · ${r.signature} — SKIP (public.specs already carries fix spec [[${r.existingSpec.slug}]])`,
      );
      continue;
    }
    if (!r.parked.length) {
      console.log(
        `  · ${r.signature} — SKIP (no live parked repair; enqueue only if the caller wants a fresh diagnosis)`,
      );
      continue;
    }
    console.log(
      `  · ${r.signature} — will resolve ${r.parked.length} parked repair(s) then enqueueRepairJob`,
    );
    for (const p of r.parked) {
      const errStr = (p.error ?? "").slice(0, 200);
      console.log(
        `      job=${p.id.slice(0, 8)} status=${p.status} created_at=${p.created_at} error="${errStr}"`,
      );
    }
  }

  if (!apply) {
    console.log(`[redrive-4-parked] dry-run — nothing mutated. Re-run with --apply to re-drive.`);
    return;
  }

  let resolved = 0;
  let enqueued = 0;
  let skipped = 0;
  for (const r of reports) {
    if (r.existingSpec) {
      console.log(
        `[redrive-4-parked] ${r.signature} — public.specs already has [[${r.existingSpec.slug}]]; nothing to do.`,
      );
      skipped++;
      continue;
    }

    // 1) Resolve any live parked repair(s) for this signature so `enqueueRepairJob`'s dedup can
    //    fire a fresh diagnosis. Compare-and-set: re-assert workspace + expected LIVE status at
    //    the write, and `.select('id')` to confirm exactly which rows transitioned — per the
    //    coaching mandate (approval-inbox.ts:789-806 pattern).
    const redriveNote =
      `[repair-author-write-surface-real-error-not-swallow P3] re-driving parked repair for ` +
      `signature ${r.signature} against the Phase-1/2 fixed code — the author-write swallow at ` +
      `markNewSpecInReview / authorSpecRow{FromMarkdown,Structured} is closed. Enqueuing a fresh ` +
      `diagnosis; the re-run either persists a spec OR surfaces the CONCRETE DB/author error string ` +
      `(never the generic 'silent author-write fallout' again).`;
    for (const p of r.parked) {
      const { data: fl, error: flErr } = await admin
        .from("agent_jobs")
        .update({
          status: "completed",
          log_tail: redriveNote.slice(-2000),
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", p.workspace_id)
        .eq("id", p.id)
        .in("status", LIVE_REPAIR_STATUSES as unknown as string[])
        .select("id");
      if (flErr) {
        console.warn(`[redrive-4-parked] flip failed for ${p.id.slice(0, 8)}: ${flErr.message}`);
        continue;
      }
      if (!Array.isArray(fl) || fl.length === 0) {
        console.log(
          `[redrive-4-parked] ${p.id.slice(0, 8)} already transitioned (compare-and-set 0 rows) — skipping`,
        );
        continue;
      }
      resolved++;

      // 2) Audit line for Ada.
      let authoredSlug: string | null = null;
      try {
        const instr = p.instructions ? JSON.parse(p.instructions) : {};
        authoredSlug = typeof instr.authored_slug === "string" ? instr.authored_slug : null;
      } catch { /* no-op */ }
      await recordDirectorActivity(admin, {
        workspaceId: p.workspace_id,
        directorFunction: "platform",
        actionKind: "spec_row_missing_escalated",
        specSlug: authoredSlug,
        reason: redriveNote,
        metadata: {
          source: "redrive_4_parked_signatures_phase3",
          prior_repair_status: p.status,
          prior_repair_error: p.error ?? null,
          repair_job_id: p.id,
          signature: r.signature,
          authored_slug: authoredSlug,
          autonomous: false,
        },
      });
    }

    // 3) Enqueue a fresh repair for this signature. Idempotent under repeat runs — the dedup catches
    //    a fresh repair already in flight (if one exists) and short-circuits.
    const workspaceId = r.parked[0]?.workspace_id;
    if (!workspaceId) {
      console.warn(
        `[redrive-4-parked] ${r.signature} — no workspace_id from parked repairs; skipping enqueue`,
      );
      continue;
    }
    const enqRes = await enqueueRepairJob(admin, {
      source: "phase3-redrive-4-parked-repair-signatures",
      signature: r.signature,
      title: `Re-fix (P3 re-drive): ${r.signature}`.slice(0, 300),
      errorEventId: null,
    });
    if (enqRes.enqueued) {
      enqueued++;
      console.log(`[redrive-4-parked] ${r.signature} → fresh repair enqueued`);
    } else {
      console.log(`[redrive-4-parked] ${r.signature} → enqueue skipped (${enqRes.reason})`);
    }
  }

  console.log(
    `[redrive-4-parked] done — ${resolved} parked repair(s) resolved, ${enqueued} fresh repair job(s) enqueued, ${skipped} signature(s) already had a fix spec (out of ${TARGET_SIGNATURES.length} target signature(s)).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
