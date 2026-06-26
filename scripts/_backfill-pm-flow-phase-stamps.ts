/**
 * One-shot reconciler sweep for `retire-md-reads-from-pm-flow` Phase 3.
 *
 * Before this spec, the post-merge hook (applyMergedBuildEffects) sometimes failed to stamp the
 * `pr` + `merge_sha` provenance on the phase(s) a merged PR shipped — silent drift that left a
 * spec's `public.specs.status` correct (the merge SHA + merged_pr were captured at the card level)
 * but left one or more `public.spec_phases` rows still `planned` despite the code being on main.
 * Three specs were caught manually via `request-audit`; the spec body's Phase 3 task is to sweep
 * the rest so the board reflects reality.
 *
 * What it does — for every `public.specs` row where:
 *   - `last_merge_sha IS NOT NULL`        (a build merged into this card at least once), AND
 *   - ≥1 `public.spec_phases` row still has `status != 'shipped'` (drift candidate)
 *
 * it looks up the originating `agent_jobs` row (the build job that landed `merged_pr`) for the
 * `instructions` (used for the `Phase N` hint when reconcileSpecDrift can't verify a prose-only
 * phase) and runs `applyMergedBuildEffects(workspace_id, slug, …)` with the captured pr + sha —
 * the SAME body the merge hook runs, just driven from the historical record. Idempotent: a phase
 * already shipped is a no-op; `stampPhaseShipped` re-applies the same pr/sha; the security-review
 * + director-top-up enqueues are deduped by sha + by pending pass.
 *
 * `--dry-run` (default) — print a manifest of candidates + the action plan, write nothing.
 * `--apply`             — execute the sweep.
 *
 * Run once, then delete the script. (script-conventions: `_`-prefix one-offs.)
 */
import { createAdminClient } from "./_bootstrap";
import { applyMergedBuildEffects } from "../src/lib/agent-jobs";

interface SpecRowMinimal {
  id: string;
  workspace_id: string;
  slug: string;
  status: string;
  last_merge_sha: string | null;
  merged_pr: number | null;
}

interface PhaseRowMinimal {
  spec_id: string;
  position: number;
  status: string;
  pr: number | null;
  merge_sha: string | null;
}

interface JobRowMinimal {
  spec_slug: string;
  workspace_id: string;
  pr_number: number | null;
  instructions: string | null;
  created_at: string;
}

interface Candidate {
  workspaceId: string;
  slug: string;
  specId: string;
  mergeSha: string;
  mergedPr: number | null;
  instructions: string | null;
  unshippedPositions: number[];
}

async function discoverCandidates(admin: ReturnType<typeof createAdminClient>): Promise<Candidate[]> {
  const { data: specs, error: sErr } = await admin
    .from("specs")
    .select("id, workspace_id, slug, status, last_merge_sha, merged_pr")
    .not("last_merge_sha", "is", null);
  if (sErr) throw sErr;
  const specRows = (specs ?? []) as SpecRowMinimal[];
  if (!specRows.length) return [];

  const specIds = specRows.map((s) => s.id);
  const { data: phases, error: pErr } = await admin
    .from("spec_phases")
    .select("spec_id, position, status, pr, merge_sha")
    .in("spec_id", specIds);
  if (pErr) throw pErr;
  const phaseRows = (phases ?? []) as PhaseRowMinimal[];

  const phasesBySpec = new Map<string, PhaseRowMinimal[]>();
  for (const p of phaseRows) {
    const arr = phasesBySpec.get(p.spec_id) ?? [];
    arr.push(p);
    phasesBySpec.set(p.spec_id, arr);
  }

  const driftedSpecs = specRows
    .map((s) => {
      const ps = phasesBySpec.get(s.id) ?? [];
      // A spec with zero phases is a one-shot card; phase-stamping is N/A (the card-level
      // last_merge_sha IS the provenance). Skip.
      if (!ps.length) return null;
      const unshipped = ps.filter((p) => p.status !== "shipped");
      if (!unshipped.length) return null;
      return { spec: s, unshippedPositions: unshipped.map((p) => p.position).sort((a, b) => a - b) };
    })
    .filter((x): x is { spec: SpecRowMinimal; unshippedPositions: number[] } => x !== null);

  if (!driftedSpecs.length) return [];

  // Look up the build job that captured each spec's `last_merge_sha` for the `instructions` text.
  // The link: `agent_jobs.pr_number === specs.merged_pr` (the PR that recorded last_merge_sha).
  // For drift cases where merged_pr was never recorded (an earlier build hook bug, before
  // phase-pr-provenance), fall back to the most-recent build for the slug.
  const slugs = [...new Set(driftedSpecs.map((d) => d.spec.slug))];
  const { data: jobs, error: jErr } = await admin
    .from("agent_jobs")
    .select("spec_slug, workspace_id, pr_number, instructions, created_at")
    .in("spec_slug", slugs)
    .eq("kind", "build")
    .order("created_at", { ascending: false });
  if (jErr) throw jErr;
  const jobRows = (jobs ?? []) as JobRowMinimal[];
  const jobByPr = new Map<string, JobRowMinimal>();
  const jobBySlug = new Map<string, JobRowMinimal>();
  for (const j of jobRows) {
    const slugKey = `${j.workspace_id}::${j.spec_slug}`;
    if (!jobBySlug.has(slugKey)) jobBySlug.set(slugKey, j); // first = most recent (desc order)
    if (j.pr_number != null) {
      jobByPr.set(`${j.workspace_id}::${j.spec_slug}::${j.pr_number}`, j);
    }
  }

  const out: Candidate[] = [];
  for (const d of driftedSpecs) {
    const s = d.spec;
    const slugKey = `${s.workspace_id}::${s.slug}`;
    const prKey = s.merged_pr != null ? `${slugKey}::${s.merged_pr}` : null;
    const job = (prKey && jobByPr.get(prKey)) || jobBySlug.get(slugKey) || null;
    out.push({
      workspaceId: s.workspace_id,
      slug: s.slug,
      specId: s.id,
      mergeSha: s.last_merge_sha as string,
      mergedPr: s.merged_pr,
      instructions: job?.instructions ?? null,
      unshippedPositions: d.unshippedPositions,
    });
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  console.log(`\nretire-md-reads-from-pm-flow Phase 3 — one-shot phase-stamp backfill`);
  console.log(`Mode: ${apply ? "APPLY (writes will land)" : "DRY-RUN (no writes)"}\n`);

  const candidates = await discoverCandidates(admin);
  if (!candidates.length) {
    console.log(`✓ No drifted specs found — every \`last_merge_sha\`-tagged spec has every phase stamped \`shipped\`. Nothing to do.\n`);
    return;
  }

  console.log(`Found ${candidates.length} candidate spec(s) with drift:\n`);
  for (const c of candidates) {
    console.log(`  • ${c.slug}  (ws ${c.workspaceId.slice(0, 8)}…)`);
    console.log(`      last_merge_sha:    ${c.mergeSha}`);
    console.log(`      merged_pr:         ${c.mergedPr ?? "(none)"}`);
    console.log(`      unshipped phases:  P${c.unshippedPositions.join(", P")}`);
    console.log(
      `      build instructions: ${c.instructions ? `"${c.instructions.slice(0, 80).replace(/\s+/g, " ")}${c.instructions.length > 80 ? "…" : ""}"` : "(none — will fall back to first-planned heuristic)"}`,
    );
  }

  if (!apply) {
    console.log(`\nRe-run with --apply to execute the sweep. Each candidate runs:`);
    console.log(`  applyMergedBuildEffects(ws, slug, { mergeSha, prNumber, instructions, chainPhases: false })`);
    console.log(`\nThe call is idempotent — already-shipped phases are no-ops; the merge hook's own dedupe`);
    console.log(`(security review by SHA, director top-up by pending pass) prevents double-fire.\n`);
    return;
  }

  let stamped = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      console.log(`→ ${c.slug}: applying merge effects (sha ${c.mergeSha.slice(0, 8)}…, PR #${c.mergedPr ?? "?"})`);
      await applyMergedBuildEffects(c.workspaceId, c.slug, {
        chainPhases: false,
        mergeSha: c.mergeSha,
        prNumber: c.mergedPr,
        instructions: c.instructions,
      });
      stamped++;
    } catch (e) {
      failed++;
      console.error(`  ✗ failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`\n✓ Sweep complete — ${stamped} spec(s) reconciled, ${failed} failed.\n`);
}

main().catch((e) => {
  console.error(`\n✗ unhandled error: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exit(1);
});
