/**
 * check-phantom-shipped-phases — the predeploy standing guard against phantom-shipped phases
 * ([[../docs/brain/specs/merge-gate-verifies-real-phase-checks-not-status-flags]] Phase 3).
 *
 * For every ACTIVE spec's `status='shipped'` phase, this runs its `spec_phase_checks` (grep) against
 * the target branch HEAD (`origin/goal/{goal-slug}` for a goal-bound spec, `origin/main` otherwise)
 * and FAILS predeploy listing any phase whose checks don't pass on the real code. Complements the
 * per-slug [[../src/lib/spec-audit]] (origin/main-only, status_history-driven) — this one is the
 * standing pipeline gate that a phantom can't hide behind a status flag.
 *
 * READ-ONLY: no writes to any table, no branch mutation, no push. If Supabase env is absent (a CI-lite
 * context without service-role creds) the check gracefully SKIPS — the box worker's predeploy still
 * runs it where the DB is reachable, which is where the phantom class actually lives.
 *
 * Run:  npx tsx scripts/_check-phantom-shipped-phases.ts
 */
import "./_bootstrap";

async function main(): Promise<void> {
  // Skip gracefully when we can't reach Supabase — the check is a live-DB scan by design, not a static
  // analysis. The box worker's predeploy has the env; a plain `npm i` CI does not, and forcing a red
  // there would break every unrelated PR without adding signal.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    console.log(
      "✓ check-phantom-shipped-phases — skipped (no Supabase env; runs where the DB is reachable).",
    );
    return;
  }

  const { detectPhantomShippedPhases } = await import("../src/lib/phantom-ship-detector");
  const report = await detectPhantomShippedPhases();

  if (report.phantoms.length === 0) {
    console.log(
      `✓ check-phantom-shipped-phases — scanned ${report.scanned} shipped phase(s) across ${report.specsScanned} spec(s) in ${report.workspacesScanned} workspace(s); 0 phantom(s).`,
    );
    return;
  }

  console.error(
    `\n❌ check-phantom-shipped-phases — ${report.phantoms.length} phase(s) marked shipped whose code is NOT on the target branch:\n`,
  );
  for (const p of report.phantoms) {
    console.error(
      `  • ${p.workspaceId}/${p.slug} phase ${p.position} on ${p.branch}: ${p.reason}`,
    );
  }
  console.error(
    `\nA phase marked \`shipped\` whose grep checks fail on the target branch is a PHANTOM ship — ` +
      `the status flag says shipped but the code isn't there. This is the wedge merge-gate-verifies-` +
      `real-phase-checks-not-status-flags Phase 3 was built to surface (v3 factor-rollup-sdk-with-` +
      `significance-gate phantom-shipped P2/P3 in the same class). Investigate: either the code was ` +
      `reverted, the phase was flipped shipped without a real merge, or the merge landed on a different ` +
      `branch than the detector expects (goal-bound specs target \`origin/goal/{goal-slug}\`, one-off ` +
      `specs \`origin/main\`).\n`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(
    "❌ check-phantom-shipped-phases threw:",
    e instanceof Error ? (e.stack ?? e.message) : e,
  );
  process.exit(1);
});
