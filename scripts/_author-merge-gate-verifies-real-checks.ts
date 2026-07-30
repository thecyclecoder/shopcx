/**
 * Authors the build-integrity fix spec: the spec→goal merge gate must verify each phase's REAL
 * machine checks against the branch HEAD (not trust a `status='shipped'` flag), fail CLOSED, and the
 * blanket-stamp reconciler must be guarded. Root cause of the v3 phantom-ships (CEO 2026-07-22).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "merge-gate-verifies-real-phase-checks-not-status-flags",
    {
      title: "Spec→goal merge gate verifies REAL per-phase checks against the branch (fail closed)",
      why:
        "The spec→goal merge gate `isSpecAccumulationComplete` (src/lib/specs-table.ts) counts a phase as 'accumulated' when `status==='shipped'` OR it carries a build_sha — it NEVER verifies the phase's actual code/checks landed on the branch. So a phase marked shipped by ANY premature mechanism counts as done with zero code. Three triggers exploit this: (1) `reconcileMergedSpecPhases` (src/lib/agent-jobs.ts) blanket-stamps remaining phases shipped off a sibling's merge SHA with no code check; (2) the accumulation gate FAILS OPEN on a read error; (3) spec-test + security pass on incomplete code (a Phase-1-only branch is tsc-clean precisely because nothing references the missing phases). Confirmed live: v3 spec factor-rollup-sdk-with-significance-gate merged spec→goal (PR #2200) with only Phase 1 built, then P2/P3 were phantom-stamped shipped though getFactorRollup was never written. This guards the integrity of EVERY future build — a spec must not merge with un-built phases.",
      what:
        "Make the accumulation/promote gate verify each phase's OWN machine checks (spec_phase_checks: grep/tsc/etc.) actually PASS against the branch HEAD before counting it accumulated — status flags are advisory, real checks are authoritative. Fail CLOSED (an unverifiable phase blocks promotion). Guard reconcileMergedSpecPhases with the same verification (never blanket-stamp a phase shipped without its checks passing on the merged code). Add a phantom-ship detector that flags a phase marked shipped whose checks fail against the branch, so existing phantoms surface.",
      summary:
        "Fix the build-integrity hole in src/lib/specs-table.ts `isSpecAccumulationComplete` + src/lib/agent-jobs.ts `reconcileMergedSpecPhases` (+ SpecPromoteEligibility): verify real per-phase checks on the branch HEAD, fail closed, guard the blanket-stamp, add a phantom-ship detector. Reuses the deterministic spec-check runner (src/lib/spec-check-runner.ts).",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Autonomous build platform" mandate: a spec that merges with un-built (phantom-shipped) phases breaks the idea→spec→build→merge loop\'s core guarantee; the merge gate must verify real code, not status flags.',
      blocked_by: [],
      human_review:
        "After ship, re-run the v3 phantom audit — a phase marked shipped whose checks fail on the goal branch must now be flagged (not counted as accumulated).",
      phases: [
        {
          title: "Phase 1 — Accumulation/promote gate verifies real per-phase checks, fails closed",
          why: "The gate trusting a status flag is the root hole — a phase with no code can read as accumulated.",
          what:
            "Introduce `verifyPhaseAccumulatedOnBranch(workspaceId, slug, phase, branchRef)` that runs the phase's spec_phase_checks (grep/tsc via the deterministic runner) against the branch HEAD and returns pass/fail. `isSpecAccumulationComplete` (src/lib/specs-table.ts) and `SpecPromoteEligibility` (src/lib/agent-jobs.ts) count a phase as accumulated ONLY when this verification passes — a `status==='shipped'` flag alone is NOT sufficient. Fail CLOSED: if the checks can't be run/read for a phase, that phase is treated as NOT accumulated (blocks the merge) rather than the current fail-open. Keep the trivially-complete short-circuit for 0-1 phase specs.",
          body:
            "Ground against src/lib/specs-table.ts `isSpecAccumulationComplete`, src/lib/agent-jobs.ts `checkSpecPromoteEligibility`/`SpecPromoteEligibility`, src/lib/spec-check-runner.ts (the runner), src/lib/spec-phase-checks-table.ts. Add the brain note per CLAUDE.md (update docs/brain/libraries/specs-table.md + tables/spec_phases.md).",
          verification: [
            "- `npx tsx --test` on the new gate unit test → a phase with status='shipped' but a FAILING grep check on the branch is reported NOT accumulated.",
            "- On the changed source, grep for `verifyPhaseAccumulatedOnBranch` → present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the branch-check verifier exists", kind: "auto", exec_kind: "grep", params: { path: "src/lib", pattern: "verifyPhaseAccumulatedOnBranch", expect: "present" } },
            { position: 3, description: "eyeball: a status=shipped phase with absent code now reads NOT accumulated", kind: "human", exec_kind: "needs_human", params: null },
          ],
        },
        {
          title: "Phase 2 — Guard reconcileMergedSpecPhases (no blanket-stamp without verified code)",
          why: "The reconciler is the mechanism that turned an incomplete merge into a phantom all-shipped.",
          what:
            "`reconcileMergedSpecPhases` (src/lib/agent-jobs.ts) must NOT stamp an unshipped phase shipped by copying a sibling's merge_sha unless `verifyPhaseAccumulatedOnBranch` confirms that phase's checks pass against the merged code. A phase that fails verification is LEFT unshipped (and surfaced to the phantom-ship detector in Phase 3) rather than blanket-stamped.",
          body: "Ground against src/lib/agent-jobs.ts `reconcileMergedSpecPhases` (the blanket-stamp loop). Reuse the Phase-1 verifier. Update docs/brain/libraries for the reconciler behavior.",
          verification: [
            "- On the changed source, grep agent-jobs.ts for `verifyPhaseAccumulatedOnBranch` inside reconcileMergedSpecPhases → present.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "reconciler uses the branch-check verifier before stamping", kind: "auto", exec_kind: "grep", params: { path: "src/lib/agent-jobs.ts", pattern: "verifyPhaseAccumulatedOnBranch", expect: "present" } },
          ],
        },
        {
          title: "Phase 3 — Phantom-ship detector (code-presence, goal-branch-aware)",
          why: "Existing phantoms (marked shipped, no code) are invisible to the current audit; surface them.",
          what:
            "Add `scripts/_check-phantom-shipped-phases.ts` (chained into predeploy as `check:phantom-shipped-phases`) that, for every spec with a shipped phase, runs that phase's grep checks against the relevant branch HEAD (goal branch for goal-bound specs, main otherwise) and FAILS listing any phase marked shipped whose checks don't pass on the real code. This is the standing guard that a phantom can't hide behind a status flag.",
          body: "Ground against src/lib/spec-audit.ts (the existing origin/main-only audit this complements), src/lib/spec-check-runner.ts, package.json predeploy chain. Add a brain page for the new check.",
          verification: [
            "- The detector script exists and is chained into predeploy.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "detector script exists", kind: "auto", exec_kind: "grep", params: { path: "scripts", pattern: "_check-phantom-shipped-phases", expect: "present" } },
            { position: 3, description: "detector chained into predeploy", kind: "auto", exec_kind: "grep", params: { path: "package.json", pattern: "check:phantom-shipped-phases", expect: "present" } },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "platform#build",
    },
  );
  console.log(ok ? "authored ✓ merge-gate-verifies-real-phase-checks-not-status-flags" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
