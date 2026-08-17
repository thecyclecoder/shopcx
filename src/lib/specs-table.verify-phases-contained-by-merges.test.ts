/**
 * Unit tests for `verifyPhasesContainedByMerges`
 * ([[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]] Phase 2 pre-fold gate).
 *
 * Pins the assertion: for every non-rejected phase, its `merge_sha` must actually contain its
 * `build_sha`. Fails on:
 *   - a `build_sha=NULL` phase (the exact shape that stranded PR #2508),
 *   - a shipped phase whose merge doesn't carry the build,
 *   - an inconclusive containment check (fail-CLOSED — the fold is a one-way door).
 *
 * `runGitCmd` is injected so these tests exercise the policy without spawning git.
 *
 * Run:
 *   npx tsx --test src/lib/specs-table.verify-phases-contained-by-merges.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyPhasesContainedByMerges,
  type PhaseContainmentInput,
  type ResolveBranchRefDeps,
} from "@/lib/specs-table";

// Every call to mergeContainsPhaseBuild issues (fetch, rev-parse, merge-base). This helper stubs each
// triplet with a preset outcome.
function makeDeps(perCall: Array<"contained" | "not-contained" | "git-error">): ResolveBranchRefDeps {
  let i = 0;
  return {
    runGitCmd: async (args) => {
      // Fetch + rev-parse always succeed; we only vary the merge-base outcome.
      if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "deadbeef\n", stderr: "" };
      const outcome = perCall[i++];
      if (outcome === "contained") return { code: 0, stdout: "", stderr: "" };
      if (outcome === "not-contained") return { code: 1, stdout: "", stderr: "" };
      return { code: 128, stdout: "", stderr: "fatal: bad object" };
    },
  };
}

test("the named failing state: P1 has build+merge that agree, P2 has build_sha=null → fails on P2 alone", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "shipped", build_sha: "a0e1172ce", merge_sha: "9ea6351de" }, // P1: valid
    { position: 2, status: "shipped", build_sha: null, merge_sha: "9ea6351de" }, // the exact P2 wedge shape
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps(["contained"]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.failures.length, 1);
    assert.equal(res.failures[0].position, 2);
    assert.match(res.failures[0].reason, /no build_sha/);
  }
});

test("a shipped phase whose merge does NOT carry its build fails with the exceeds-evidence reason", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "shipped", build_sha: "aaaaaaa", merge_sha: "bbbbbbb" }, // not contained
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps(["not-contained"]));
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.failures[0].position, 1);
    assert.match(res.failures[0].reason, /does NOT contain its build/);
  }
});

test("an inconclusive containment check (git error) fails CLOSED — the fold is a one-way door", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "shipped", build_sha: "aaaaaaa", merge_sha: "bbbbbbb" },
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps(["git-error"]));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.failures[0].reason, /inconclusive/);
});

test("a rejected phase is skipped — the spec never expected it to ship", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "shipped", build_sha: "aaaaaaa", merge_sha: "bbbbbbb" }, // check contained
    { position: 2, status: "rejected", build_sha: null, merge_sha: null }, // skipped
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps(["contained"]));
  assert.equal(res.ok, true);
});

test("a healthy fully-shipped spec (every phase build_sha in its merge) passes", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "shipped", build_sha: "aaaaaaa", merge_sha: "deadbee" },
    { position: 2, status: "shipped", build_sha: "bbbbbbb", merge_sha: "deadbee" },
    { position: 3, status: "shipped", build_sha: "ccccccc", merge_sha: "deadbee" },
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps(["contained", "contained", "contained"]));
  assert.equal(res.ok, true);
});

test("a non-terminal phase with build_sha but no merge_sha is flagged as not-yet-on-main", async () => {
  const phases: PhaseContainmentInput[] = [
    { position: 1, status: "in_progress", build_sha: "aaaaaaa", merge_sha: null },
  ];
  const res = await verifyPhasesContainedByMerges(phases, makeDeps([]));
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.failures[0].reason, /no merge_sha — not yet on main/);
});

test("empty phase list is a no-op pass (one-shot specs carry provenance at the card, not per phase)", async () => {
  const res = await verifyPhasesContainedByMerges([], makeDeps([]));
  assert.equal(res.ok, true);
});
