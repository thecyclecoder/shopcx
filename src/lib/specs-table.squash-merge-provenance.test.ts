/**
 * Unit tests for the squash-merge provenance fallback in `verifyPhasesContainedByMerges`
 * (spec: fold-accepts-squash-merge-provenance).
 *
 * A squash merge replays the branch as ONE new single-parent commit and drops the branch commits, so
 * a phase's `build_sha` can never be an ancestor of the merge — and once the branch is deleted the
 * build SHA may not resolve at all. The pre-fold gate answered that fail-closed and permanently
 * stranded four specs whose code was demonstrably on main (2026-08-31).
 *
 * These tests pin BOTH directions:
 *   - a squash merge that landed on main is accepted despite failing/erroring containment, AND
 *   - every case the guard was built to catch STILL fails: a real (two-parent) merge whose ancestry
 *     genuinely disagrees, a merge that is not on main at all, and a phase with no build evidence.
 *
 * `runGitCmd` is injected so these exercise the policy without spawning git.
 *
 * Run:
 *   npx tsx --test src/lib/specs-table.squash-merge-provenance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyPhasesContainedByMerges,
  mergeIsSquashOnMain,
  type PhaseContainmentInput,
  type ResolveBranchRefDeps,
} from "@/lib/specs-table";

const MAIN_REF = "MAINREF";
const MERGE_SHA = "777cda9f8";
const BUILD_SHA = "abdd9e1e1";

/**
 * Routes each git call by shape rather than by call order, so a change in call count can't silently
 * re-point a stub at the wrong assertion:
 *   fetch / rev-parse                              → always succeed (rev-parse resolves origin/main)
 *   merge-base --is-ancestor <build> <merge>       → `containment`
 *   merge-base --is-ancestor <merge> MAINREF       → `onMain`
 *   rev-list --parents -n 1 <merge>                → `parents` (2 tokens ⇒ squash, 3 ⇒ real merge)
 */
function makeDeps(opts: {
  containment: "contained" | "not-contained" | "git-error";
  onMain: boolean;
  parents: 1 | 2;
  merge?: string;
}): ResolveBranchRefDeps {
  const merge = opts.merge ?? MERGE_SHA;
  return {
    runGitCmd: async (args) => {
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: `${MAIN_REF}\n`, stderr: "" };
      if (args[0] === "rev-list") {
        const target = args[args.length - 1];
        const parentShas = opts.parents === 1 ? "p1" : "p1 p2";
        return { code: 0, stdout: `${target} ${parentShas}\n`, stderr: "" };
      }
      if (args[0] === "merge-base") {
        // containment probe is `--is-ancestor <build> <merge>`; the squash probe is
        // `--is-ancestor <merge> <mainRef>`. Discriminate on the FIRST operand, not the last —
        // resolveBranchRefForVerification returns a ref NAME, not the rev-parse output.
        const isOnMainProbe = args[2] === merge;
        if (isOnMainProbe) return { code: opts.onMain ? 0 : 1, stdout: "", stderr: "" };
        if (opts.containment === "contained") return { code: 0, stdout: "", stderr: "" };
        if (opts.containment === "not-contained") return { code: 1, stdout: "", stderr: "" };
        return { code: 128, stdout: "", stderr: "fatal: Not a valid commit name" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

const shipped = (over: Partial<PhaseContainmentInput> = {}): PhaseContainmentInput => ({
  position: 1,
  status: "shipped",
  build_sha: BUILD_SHA,
  merge_sha: MERGE_SHA,
  ...over,
});

test("squash merge on main: build is NOT an ancestor, but the fold is allowed", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped()],
    makeDeps({ containment: "not-contained", onMain: true, parents: 1 }),
  );
  assert.equal(res.ok, true);
});

test("squash merge on main: build SHA no longer resolves (branch deleted) — still allowed", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped({ build_sha: "2059495af" })],
    makeDeps({ containment: "git-error", onMain: true, parents: 1 }),
  );
  assert.equal(res.ok, true);
});

test("REAL merge commit (two parents) whose ancestry disagrees STILL fails — the guard is intact", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped()],
    makeDeps({ containment: "not-contained", onMain: true, parents: 2 }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.failures[0].reason, /does NOT contain its build/);
});

test("a merge that is NOT on main STILL fails, even though it is single-parent", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped()],
    makeDeps({ containment: "not-contained", onMain: false, parents: 1 }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.failures[0].reason, /does NOT contain its build/);
});

test("build_sha=null STILL fails — the PR #2508 protection is NOT relaxed by this change", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped({ build_sha: null })],
    makeDeps({ containment: "contained", onMain: true, parents: 1 }),
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.failures[0].reason, /no build_sha/);
});

test("a genuinely contained phase still passes without consulting the squash fallback", async () => {
  const res = await verifyPhasesContainedByMerges(
    [shipped()],
    makeDeps({ containment: "contained", onMain: false, parents: 2 }),
  );
  assert.equal(res.ok, true);
});

test("mergeIsSquashOnMain: true only for a single-parent commit reachable from origin/main", async () => {
  assert.equal(await mergeIsSquashOnMain("777cda9f8", makeDeps({ containment: "contained", onMain: true, parents: 1 })), true);
  assert.equal(await mergeIsSquashOnMain("777cda9f8", makeDeps({ containment: "contained", onMain: true, parents: 2 })), false);
  assert.equal(await mergeIsSquashOnMain("777cda9f8", makeDeps({ containment: "contained", onMain: false, parents: 1 })), false);
});

test("mergeIsSquashOnMain: refuses a malformed sha rather than shelling out", async () => {
  assert.equal(await mergeIsSquashOnMain("not-a-sha", makeDeps({ containment: "contained", onMain: true, parents: 1 })), false);
  assert.equal(await mergeIsSquashOnMain(null, makeDeps({ containment: "contained", onMain: true, parents: 1 })), false);
});
