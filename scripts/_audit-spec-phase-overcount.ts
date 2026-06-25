/**
 * _audit-spec-phase-overcount — find specs whose phase count is inflated by `### Phase N`
 * verification subheaders (PR #557 + spec-phase-parser-skip-verification-subsections), and
 * (with --apply) reconcile their `spec_card_state` so the phantom phases drop off the board.
 *
 * Background — the strand:
 *   PR #557 widened `parsePhasesWithLines` (src/lib/spec-drift.ts) to match `### Phase` so a
 *   `## Phases\n### Phase N` wrapper spec could be parsed. The widening had NO scope guard, so
 *   an H3 `### Phase N` under `## Verification` was double-counted as a real phase. Auto-flip
 *   then flips ≤ N phases and the spec strands at planned/in_progress with phantom ⏳ phases.
 *   spec-phase-parser-skip-verification-subsections Phase 1 fixed the parser; THIS script is the
 *   Phase 2 cleanup over the already-strand specs.
 *
 * Two phases:
 *   1. Dry-run (default): scan every `docs/brain/specs/*.md`, compute the old (H2 + every H3
 *      `### Phase`) phase count vs the new (H2 + scope-guarded H3) phase count, and print a JSON
 *      manifest of every spec whose count dropped — with slug, before_count, after_count, and the
 *      dropped H3 subheader titles. Read-only.
 *   2. --apply: for each strand spec, run a fresh `reconcileSpecDrift` pass so the per-phase
 *      mirror in `spec_card_state` re-syncs against the corrected phase list (idempotent + non-
 *      destructive — only flips ⏳→✅ where code-on-main exists; never regresses a shipped phase),
 *      then write ONE `director_activity` row per strand spec (action_kind=
 *      `phase_parser_strand_reconciled`) carrying before_count, after_count, and the new
 *      shipped/planned counts so the audit trail captures the cleanup.
 *
 * Defensive by design: a per-spec failure is logged but does NOT abort the run — the manifest
 * already printed is useful even if the apply pass errors, and the script ALWAYS exits 0 so a
 * partial cleanup can be retried (the reconcile + director_activity write are idempotent).
 *
 * Usage:
 *   npx tsx scripts/_audit-spec-phase-overcount.ts            # dry-run manifest only
 *   npx tsx scripts/_audit-spec-phase-overcount.ts --apply    # reconcile + audit-row write
 */
import "./_bootstrap";
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { parsePhasesWithLines } from "../src/lib/spec-drift";

const WORKSPACE_ID = process.env.AGENT_TODO_WORKSPACE_ID || "fdc11e10-b89f-4989-8b73-ed6526c4d906";

interface StrandRow {
  slug: string;
  before_count: number;
  after_count: number;
  dropped_h3_titles: string[];
}

/**
 * Pre-fix "old parser" simulation — counts EVERY `^#{2,3}\s+Phase\b` line as a phase (the PR #557
 * shape), and also names every H3 phase line that the NEW parser SKIPS (an H3 outside a `## Phases`
 * wrapper). Used purely for the audit diff against the corrected `parsePhasesWithLines` output.
 */
function oldPhaseScan(raw: string): { count: number; droppedH3Titles: string[] } {
  const lines = raw.split("\n");
  const droppedH3Titles: string[] = [];
  let count = 0;
  let currentH2: string | null = null;
  for (const l of lines) {
    if (/^##\s+/.test(l)) currentH2 = l.replace(/^##\s+/, "").trim();
    if (!/^#{2,3}\s+Phase\b/.test(l)) continue;
    count++;
    if (l.startsWith("### ") && !/^Phases$/i.test(currentH2 ?? "")) {
      droppedH3Titles.push(
        l
          .replace(/^#{2,3}\s+/, "")
          .replace(/[⏳🚧✅❌]/g, "")
          .replace(/\*\*/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
  }
  return { count, droppedH3Titles };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const specsDir = resolve(__dirname, "../docs/brain/specs");
  const files = readdirSync(specsDir).filter((f) => f.endsWith(".md") && f !== "README.md");

  const strands: StrandRow[] = [];
  for (const f of files) {
    const raw = readFileSync(join(specsDir, f), "utf8");
    const after_count = parsePhasesWithLines(raw).length;
    const { count: before_count, droppedH3Titles } = oldPhaseScan(raw);
    if (before_count <= after_count) continue; // no over-count to fix
    const slug = f.replace(/\.md$/, "");
    strands.push({
      slug,
      before_count,
      after_count,
      dropped_h3_titles: droppedH3Titles,
    });
  }

  // Manifest first — readable in either mode, and survives an apply-loop failure later.
  console.log(JSON.stringify({ workspace_id: WORKSPACE_ID, strand_count: strands.length, strands }, null, 2));

  if (!apply) {
    console.log("\n[dry-run] Re-run with --apply to reconcile spec_card_state + write director_activity rows.");
    return;
  }
  if (!strands.length) {
    console.log("\n[apply] No strand specs — nothing to reconcile.");
    return;
  }

  // Lazy-load the prod-mutating modules — keeps the dry-run path independent of any heavy spec-drift
  // side-effect (and lets a missing env on a dry-run-only machine still print the manifest cleanly).
  let reconcileSpecDrift: typeof import("../src/lib/spec-drift").reconcileSpecDrift;
  let createAdminClient: typeof import("../src/lib/supabase/admin").createAdminClient;
  let recordDirectorActivity: typeof import("../src/lib/director-activity").recordDirectorActivity;
  try {
    ({ reconcileSpecDrift } = await import("../src/lib/spec-drift"));
    ({ createAdminClient } = await import("../src/lib/supabase/admin"));
    ({ recordDirectorActivity } = await import("../src/lib/director-activity"));
  } catch (err) {
    console.error(`[apply] failed to load prod modules: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const admin = createAdminClient();
  let ok = 0;
  let failed = 0;
  for (const s of strands) {
    process.stdout.write(`[apply] ${s.slug} (was ${s.before_count} phases → now ${s.after_count}) … `);
    let reconcileOk = false;
    let reconcileSummary = "";
    let phaseStates: { index: number; title: string; status: string }[] = [];
    let statusAfter: string | undefined;
    try {
      const result = await reconcileSpecDrift(WORKSPACE_ID, s.slug);
      reconcileOk = true;
      phaseStates = (result.phaseStates ?? []) as typeof phaseStates;
      statusAfter = result.status;
      reconcileSummary = `status=${result.status}, phases=${phaseStates.length}${result.reason ? `, ${result.reason}` : ""}`;
    } catch (err) {
      reconcileSummary = `reconcile threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    const shipped_after = phaseStates.filter((p) => p.status === "shipped").length;
    const planned_after = phaseStates.filter((p) => p.status === "planned").length;

    // Audit row lands regardless — captures the parser-strand cleanup attempt even on a partial reconcile.
    try {
      await recordDirectorActivity(admin, {
        workspaceId: WORKSPACE_ID,
        directorFunction: "platform",
        actionKind: "phase_parser_strand_reconciled",
        specSlug: s.slug,
        reason: `parser over-count cleanup (PR #557 strand) — ${s.before_count} → ${s.after_count} phases after skipping ${s.dropped_h3_titles.length} verification subheader(s)`,
        metadata: {
          before_count: s.before_count,
          after_count: s.after_count,
          dropped_h3_titles: s.dropped_h3_titles,
          shipped_after,
          planned_after,
          status_after: statusAfter ?? null,
          reconcile_ok: reconcileOk,
          reconcile_summary: reconcileSummary,
        },
      });
    } catch (err) {
      reconcileSummary += `; audit-row threw: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (reconcileOk) {
      ok++;
      console.log(`ok (${reconcileSummary})`);
    } else {
      failed++;
      console.log(`reconcile failed (${reconcileSummary}) — audit row landed`);
    }
  }
  console.log(`\n[apply] Done. Reconciled ${ok}/${strands.length} strand spec(s); ${failed} failed (idempotent — safe to retry).`);
}

main().then(
  () => process.exit(0),
  (err) => {
    // Never exit non-zero — the manifest has already printed (the most important output), and any
    // remaining cleanup is idempotent + safe to retry. Surface the error for triage and move on.
    console.error("[audit] top-level rejection:", err instanceof Error ? err.stack || err.message : err);
    process.exit(0);
  },
);
