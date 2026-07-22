/**
 * Unit tests for the phantom-ship detector
 * ([[../specs/merge-gate-verifies-real-phase-checks-not-status-flags]] Phase 3).
 *
 * Pins Phase-3's Verification bullets:
 *   - "detector script exists"       — covered by the presence of scripts/_check-phantom-shipped-phases.ts
 *   - "detector chained into predeploy" — covered by package.json's predeploy chain including
 *     `check:phantom-shipped-phases`
 *   - correct-state behavior — this file: a status=shipped phase whose grep check FAILS on the target
 *     branch is REPORTED as a phantom; a status=shipped phase whose grep check PASSES is NOT reported;
 *     status=in_progress phases are NEVER checked (out of scope for the phantom class); goal-bound
 *     specs verify against `origin/goal/{goal-slug}`, one-off specs against `origin/main`.
 *
 * Pure — no I/O. DI is threaded through both the detector and the underlying
 * `verifyPhaseAccumulatedOnBranch`. Run:
 *   npx tsx --test src/lib/phantom-ship-detector.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectPhantomShippedPhases,
  branchForGoal,
  type DetectorDeps,
} from "./phantom-ship-detector";
import type { VerifyPhaseDeps } from "./specs-table";
import type { GrepCheckParams } from "./spec-phase-checks-table";

// -- branchForGoal (pure resolver) ---------------------------------------------------------------

test("branchForGoal: one-off spec (null goalSlug) → origin/main", () => {
  assert.equal(branchForGoal(null), "origin/main");
});

test("branchForGoal: goal-bound spec → origin/goal/{goal-slug}", () => {
  assert.equal(branchForGoal("my-goal"), "origin/goal/my-goal");
});

test("branchForGoal: empty/whitespace goalSlug → origin/main (a slug of only whitespace is not goal-bound)", () => {
  assert.equal(branchForGoal(""), "origin/main");
  assert.equal(branchForGoal("   "), "origin/main");
});

// -- detectPhantomShippedPhases (the detector) --------------------------------------------------

/**
 * Test scaffolding: a verifier that reads a per-position pattern (via loadPhaseGrepChecks) and returns
 * pass/fail per pattern (via runGitGrepOnBranch). This is what makes per-position phantom simulation
 * possible without mocking git.
 */
function makeVerifyDeps(matches: Record<string, boolean>): VerifyPhaseDeps {
  return {
    loadPhaseFlags: async (_ws, _slug, position) => ({
      id: `phase-${position}`,
      status: "shipped",
      build_sha: "deadbeef",
    }),
    loadPhaseGrepChecks: async (phaseId) => {
      const params: GrepCheckParams = { pattern: `symbolFor_${phaseId}`, expect: "present" };
      return [{ description: `${phaseId} exports its code`, params }];
    },
    runGitGrepOnBranch: async (_branch, params) => {
      const ok = matches[params.pattern] === true;
      return { ok, evidence: ok ? "found" : "no match" };
    },
  };
}

test("phantom detected: a status=shipped phase whose grep check FAILS on the branch is reported (the wedge class)", async () => {
  const deps: DetectorDeps = {
    listWorkspaces: async () => ["ws-1"],
    listActiveSpecsFor: async () => [
      {
        slug: "my-spec",
        phases: [
          { position: 1, status: "shipped" },
          { position: 2, status: "shipped" }, // phantom: pattern for this phase is absent below
          { position: 3, status: "in_progress" }, // not shipped → NOT checked
        ],
      },
    ],
    resolveTargetBranch: async () => "origin/main",
    verifyDeps: makeVerifyDeps({
      "symbolFor_phase-1": true, // present on branch
      // "symbolFor_phase-2" ABSENT — phantom
    }),
  };
  const r = await detectPhantomShippedPhases(deps);
  assert.equal(r.workspacesScanned, 1);
  assert.equal(r.specsScanned, 1);
  assert.equal(r.scanned, 2, "only shipped phases (1 and 2) are verified — the in_progress phase 3 is skipped");
  assert.equal(r.phantoms.length, 1);
  assert.equal(r.phantoms[0].slug, "my-spec");
  assert.equal(r.phantoms[0].position, 2);
  assert.equal(r.phantoms[0].branch, "origin/main");
  assert.match(r.phantoms[0].reason, /no match/);
});

test("clean case: every shipped phase's code is present on the branch → 0 phantoms", async () => {
  const deps: DetectorDeps = {
    listWorkspaces: async () => ["ws-1"],
    listActiveSpecsFor: async () => [
      {
        slug: "my-spec",
        phases: [
          { position: 1, status: "shipped" },
          { position: 2, status: "shipped" },
        ],
      },
    ],
    resolveTargetBranch: async () => "origin/main",
    verifyDeps: makeVerifyDeps({ "symbolFor_phase-1": true, "symbolFor_phase-2": true }),
  };
  const r = await detectPhantomShippedPhases(deps);
  assert.equal(r.scanned, 2);
  assert.equal(r.phantoms.length, 0);
});

test("goal-bound spec verifies against origin/goal/{goal-slug} — one-off against origin/main", async () => {
  const branchesUsed: string[] = [];
  const deps: DetectorDeps = {
    listWorkspaces: async () => ["ws-1"],
    listActiveSpecsFor: async () => [
      { slug: "spec-a", phases: [{ position: 1, status: "shipped" }] }, // goal-bound
      { slug: "spec-b", phases: [{ position: 1, status: "shipped" }] }, // one-off
    ],
    resolveTargetBranch: async (_ws, slug) => {
      const branch = slug === "spec-a" ? branchForGoal("goal-x") : branchForGoal(null);
      branchesUsed.push(`${slug}:${branch}`);
      return branch;
    },
    verifyDeps: makeVerifyDeps({ "symbolFor_phase-1": true }),
  };
  const r = await detectPhantomShippedPhases(deps);
  assert.equal(r.phantoms.length, 0);
  assert.deepEqual(branchesUsed.sort(), ["spec-a:origin/goal/goal-x", "spec-b:origin/main"]);
});

test("spec with no shipped phases is skipped (no target-branch resolve, no verify — cheap fast path)", async () => {
  let resolves = 0;
  const deps: DetectorDeps = {
    listWorkspaces: async () => ["ws-1"],
    listActiveSpecsFor: async () => [
      { slug: "planned-only", phases: [{ position: 1, status: "planned" }] },
      { slug: "in-progress-only", phases: [{ position: 1, status: "in_progress" }] },
    ],
    resolveTargetBranch: async () => {
      resolves++;
      return "origin/main";
    },
    verifyDeps: makeVerifyDeps({}),
  };
  const r = await detectPhantomShippedPhases(deps);
  assert.equal(r.scanned, 0);
  assert.equal(r.phantoms.length, 0);
  assert.equal(resolves, 0, "no shipped phase → never resolve the target branch");
});

test("multi-workspace: the detector fans out over every workspace and aggregates phantoms", async () => {
  const specsByWs: Record<string, Array<{ slug: string; phases: Array<{ position: number; status: string }> }>> = {
    "ws-1": [{ slug: "spec-a", phases: [{ position: 1, status: "shipped" }] }],
    "ws-2": [{ slug: "spec-b", phases: [{ position: 1, status: "shipped" }] }],
  };
  const deps: DetectorDeps = {
    listWorkspaces: async () => ["ws-1", "ws-2"],
    listActiveSpecsFor: async (ws) => specsByWs[ws] ?? [],
    resolveTargetBranch: async () => "origin/main",
    verifyDeps: makeVerifyDeps({ "symbolFor_phase-1": false }), // both are phantoms
  };
  const r = await detectPhantomShippedPhases(deps);
  assert.equal(r.workspacesScanned, 2);
  assert.equal(r.specsScanned, 2);
  assert.equal(r.scanned, 2);
  assert.equal(r.phantoms.length, 2);
  assert.deepEqual(r.phantoms.map((p) => `${p.workspaceId}/${p.slug}`).sort(), [
    "ws-1/spec-a",
    "ws-2/spec-b",
  ]);
});
