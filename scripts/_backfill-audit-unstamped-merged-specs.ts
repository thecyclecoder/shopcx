/**
 * Ship-time backfill: route every ALREADY-stranded spec (build merged, but no phase carries any
 * merge provenance) through the same `audit-spec-shipped-state` hand-off Phase 1 wires for future
 * passes. Phase 2 of [[../docs/brain/specs/merged-but-unstamped-specs-reach-the-audit-instead-of-
 * being-dropped]].
 *
 * WHY. Phase 1 makes `reconcileMergedSpecPhases` (src/lib/agent-jobs.ts) enqueue the audit lane
 * instead of silently dropping a merged-but-unstamped spec — but that only rescues specs the
 * reconciler VISITS from now on. The specs stranded BEFORE the Phase-1 landing are the reason the
 * gap was noticed; they stay stuck (board reads "planned" forever, fold never fires, downstream
 * specs blocked on a prerequisite that in fact already shipped) until something clears them. Known
 * stranded set at 2026-08-25 authoring:
 *   - classify-portal-vault-failed-card-declines-instead-of-escalating (deployed healthy 2026-08-20)
 *   - loyalty-redeem-and-coupon-usability-span-linked-accounts
 *   - policy-bait-guard-must-not-block-descriptions-of-already-completed-split-refunds
 *   - overcharge-detector-baseline-must-be-a-sustained-rate-not-a-single-minimum
 *   - cancel-journey-saved-remedy-must-not-trap-a-re-requesting-customer
 * Also: cs-director-must-timestamp-a-cancelled-but-charged-claim is blocked on
 * cancelled-subs-stop-reporting-a-future-billing-date (itself in the set) — once the audit re-stamps
 * the prerequisite, that one becomes eligible to build.
 *
 * WHAT. Enumerate every `kind='build'` `agent_jobs` row at `status='merged'` (only merged — a
 * `dismissed` build is a different class and the spec explicitly excludes it: stamping or auditing
 * one would invent a ship), resolve each distinct spec through the [[../src/lib/specs-table]]
 * `getSpec` SDK (never raw `.from('specs')` — CLAUDE.md § Local conventions), and select the specs
 * with AT LEAST ONE phase whose status is neither `shipped` nor `rejected` AND NO phase carrying a
 * `merge_sha`. For each selected spec, call the SAME shared enqueue helper Phase 1 extracts
 * ([[../src/lib/agent-jobs]] `enqueueAuditSpecShippedStateIfDue`) so this pass and the automatic
 * reconciler hand-off cannot drift on insert shape or dedupe window.
 *
 * SAFETY.
 *  - Never stamps a phase itself. Only enqueues the audit lane, which walks the merge ledger to
 *    stamp REAL provenance (or leave a tagless phase unstamped when no evidence exists). The
 *    fail-closed phantom-ship guard in `reconcileMergedSpecPhases` is untouched.
 *  - Idempotent by construction: the shared helper dedupes on OPEN audits (any ACTIVE status) AND
 *    RECENT TERMINAL audits within `AUDIT_SPEC_SHIPPED_STATE_TERMINAL_DEDUPE_MS` (24h), so a re-run
 *    that fires while yesterday's pass is still in flight (or has already completed) enqueues
 *    nothing new.
 *  - Two-phase per the repo convention: prints a dry-run manifest by default; only enqueues under
 *    `--apply` (or `APPLY=1`).
 *  - Ship-time backfill genre: auto-ledgered into `public.data_op_runs` by the post-merge hook
 *    ([[../src/lib/ship-time-backfill-detector]] `detectAndEscalateShipTimeBackfills`) and drained on
 *    the box by [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`. Safe
 *    to re-run manually any time.
 *
 *   npx tsx scripts/_backfill-audit-unstamped-merged-specs.ts           # dry-run
 *   npx tsx scripts/_backfill-audit-unstamped-merged-specs.ts --apply   # write
 *   APPLY=1 npx tsx scripts/_backfill-audit-unstamped-merged-specs.ts   # write
 */
import { createAdminClient } from "./_bootstrap";
import { getSpec, type SpecRow, type SpecPhaseRow } from "../src/lib/specs-table";
import { enqueueAuditSpecShippedStateIfDue } from "../src/lib/agent-jobs";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

/**
 * Pure selection predicate — GUARD BEFORE MUTATION (coaching #11 / #12 / #14). Exported for the
 * unit test so the "no false stranded specs, no dismissed builds swept in" contract is a durable
 * regression pin, not a re-derivation at each caller.
 *
 * STRANDED = a spec whose build MERGED but whose phases carry NO provenance AT ALL:
 *   (a) at least one phase whose status is neither `shipped` nor `rejected` (something is un-done),
 *   (b) AND no phase carries a `merge_sha` (the reconciler has no shipped sibling to copy from —
 *       the exact "handed off to the audit lane" case in `reconcileMergedSpecPhases`).
 *
 * A one-shot spec (`phases.length === 0`) carries provenance at the card level, not per phase, so it
 * fails clause (a) — never in scope for this backfill. A partially-shipped spec (any phase already
 * carries a merge_sha) is a sibling for the reconciler to copy from — also excluded here.
 */
export function selectStrandedSpecsForAudit<T extends { slug: string; phases: Pick<SpecPhaseRow, "status" | "merge_sha">[] }>(
  specs: T[],
): T[] {
  return specs.filter((s) => {
    const phases = s.phases ?? [];
    if (phases.length === 0) return false;
    const anyUndone = phases.some((p) => p.status !== "shipped" && p.status !== "rejected");
    const noProvenance = phases.every((p) => !p.merge_sha);
    return anyUndone && noProvenance;
  });
}

type StrandedJob = { workspace_id: string; spec_slug: string; job_id: string; created_at: string };

async function main(): Promise<void> {
  const admin = createAdminClient();

  // Only `status='merged'` — the spec explicitly excludes `dismissed` builds (a different class;
  // auditing one would invent a ship). No workspace scoping: this is a repo-wide sweep, and the
  // pooler ordering by created_at keeps the dedupe seen-set deterministic across runs.
  const { data: rows, error } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, spec_slug, created_at")
    .eq("kind", "build")
    .eq("status", "merged")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`agent_jobs select failed: ${error.message}`);

  const jobs: StrandedJob[] = ((rows ?? []) as Array<{ id: string; workspace_id: string; spec_slug: string | null; created_at: string }>)
    .filter((r): r is StrandedJob & { id: string; spec_slug: string } => Boolean(r.spec_slug))
    .map((r) => ({ workspace_id: r.workspace_id, spec_slug: r.spec_slug, job_id: r.id, created_at: r.created_at }));

  // Dedupe (workspace, slug) to the most recent merged build (the .order above puts newest first,
  // and we walk once — a slug seen with an earlier merge job stays with its first-seen row for the
  // manifest).
  const seen = new Set<string>();
  const distinct: StrandedJob[] = [];
  for (const j of jobs) {
    const key = `${j.workspace_id}:${j.spec_slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(j);
  }

  // Resolve each spec via the SDK, skipping any slug the SDK can't resolve (archived / folded — the
  // SDK returns null on a missing row).
  type Candidate = { job: StrandedJob; spec: SpecRow };
  const candidates: Candidate[] = [];
  for (const j of distinct) {
    let spec: SpecRow | null;
    try {
      spec = await getSpec(j.workspace_id, j.spec_slug);
    } catch (e) {
      console.warn(`[skip] ${j.spec_slug}: getSpec threw — ${errText(e)}`);
      continue;
    }
    if (!spec) continue; // slug no longer resolvable (archived / folded)
    candidates.push({ job: j, spec });
  }

  const stranded = selectStrandedSpecsForAudit(candidates.map((c) => ({ ...c, slug: c.spec.slug, phases: c.spec.phases })))
    .map((s) => ({ job: (s as unknown as Candidate).job, spec: (s as unknown as Candidate).spec }));

  console.log(
    `merged-build scan: ${jobs.length} rows · ${distinct.length} distinct (workspace, slug) · ` +
      `${candidates.length} resolved · ${stranded.length} STRANDED (audit hand-off candidates) · ` +
      `mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );
  if (!stranded.length) {
    console.log("nothing to backfill.");
    return;
  }

  for (const { job, spec } of stranded) {
    const undonePhases = spec.phases.filter((p) => p.status !== "shipped" && p.status !== "rejected").length;
    const line =
      `  ${APPLY ? "hand-off" : "would hand off"} slug=${spec.slug} ws=${job.workspace_id} ` +
      `merged-job=${job.job_id.slice(0, 8)} phases=${spec.phases.length} undone=${undonePhases}`;
    if (!APPLY) {
      console.log(line);
      continue;
    }
    try {
      const res = await enqueueAuditSpecShippedStateIfDue(job.workspace_id, spec.slug, {
        requestedBy: "backfill:audit-unstamped-merged-specs",
        reason: "stranded pre-Phase-1: merged build has no phase-level provenance to copy from",
        adminClient: admin,
      });
      if (res.enqueued) console.log(`${line} → queued audit-spec-shipped-state job=${res.jobId.slice(0, 8)}`);
      else console.log(`${line} → dedupe=${res.dedup} (existing job=${res.existingJobId.slice(0, 8)}) — no new row`);
    } catch (e) {
      console.warn(`${line} → enqueue failed: ${errText(e)}`);
    }
  }

  if (!APPLY) {
    console.log(`\ndry-run only. Re-run with --apply (or APPLY=1) to hand off ${stranded.length} spec(s) to the audit lane.`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error(errText(e));
    process.exit(1);
  });
}
