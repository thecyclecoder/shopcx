/**
 * Unit tests for `resolveBranchRefForVerification`
 * ([[../specs/phase-accumulation-verifies-the-pushed-branch-not-the-boxs-local-copy]] Phase 1).
 *
 * Pins the correct state per the spec's Phase-1 Verification bullet:
 *   "the branch is resolved through a remote-tracking ref before verification"
 *
 * The resolver must:
 *   - reject spec-authored branch strings as an untrusted capability boundary (leading `-`, whitespace,
 *     NUL, empty) BEFORE ever spawning git;
 *   - targeted-fetch the ONE ref (never fetch the world);
 *   - verify `origin/<branch>` resolves via `git rev-parse` before returning it;
 *   - apply the unsafe-ref rejection to the resolved ref too.
 *
 * `runGitCmd` is injected so these tests exercise the policy without spawning git.
 *
 * Run:
 *   npx tsx --test src/lib/specs-table.resolve-branch-ref.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBranchRefForVerification,
  type ResolveBranchRefDeps,
} from "@/lib/specs-table";

type GitCall = { args: string[] };

function makeSpy(
  responses: Array<{ code: number | null; stdout?: string; stderr?: string; error?: string }>,
): { deps: ResolveBranchRefDeps; calls: GitCall[] } {
  const calls: GitCall[] = [];
  let i = 0;
  const deps: ResolveBranchRefDeps = {
    runGitCmd: async (args) => {
      calls.push({ args });
      const r = responses[i++] ?? { code: 0, stdout: "", stderr: "" };
      return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
    },
  };
  return { deps, calls };
}

test("rejects empty branch WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await resolveBranchRefForVerification("", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe branch/);
  assert.equal(calls.length, 0, "must not spawn git for unsafe input");
});

test("rejects leading-dash branch WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await resolveBranchRefForVerification("-oops", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe branch/);
  assert.equal(calls.length, 0);
});

test("rejects whitespace-in-branch WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await resolveBranchRefForVerification("branch with space", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe branch/);
  assert.equal(calls.length, 0);
});

test("rejects NUL-in-branch WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await resolveBranchRefForVerification("bad\0branch", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe branch/);
  assert.equal(calls.length, 0);
});

test("targeted-fetches origin/<branch> then rev-parses it — returns the RESOLVED ref, not the bare name", async () => {
  const { deps, calls } = makeSpy([
    { code: 0 }, // fetch ok
    { code: 0, stdout: "deadbeef\n" }, // rev-parse ok
  ]);
  const r = await resolveBranchRefForVerification("claude/build-x", deps);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.ref, "origin/claude/build-x");
  assert.equal(calls.length, 2, "one fetch + one rev-parse");
  // fetch must be TARGETED (one ref, not the world)
  assert.deepEqual(calls[0].args, [
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    "+refs/heads/claude/build-x:refs/remotes/origin/claude/build-x",
  ]);
  // rev-parse must verify the RESOLVED remote-tracking ref (never the bare name)
  assert.deepEqual(calls[1].args, ["rev-parse", "--verify", "--quiet", "origin/claude/build-x"]);
});

test("fetch failure surfaces the git error verbatim — does NOT silently fall back to the bare local ref", async () => {
  const { deps, calls } = makeSpy([
    { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/claude/build-missing" },
  ]);
  const r = await resolveBranchRefForVerification("claude/build-missing", deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /git fetch origin claude\/build-missing/);
    assert.match(r.error, /couldn't find remote ref/);
  }
  assert.equal(calls.length, 1, "must stop after fetch fails — never grep whatever local ref shares the name");
});

test("rev-parse failure surfaces the git error verbatim — does NOT silently fall back", async () => {
  const { deps, calls } = makeSpy([
    { code: 0 }, // fetch "succeeds" but produced no ref (rare half-broken remote)
    { code: 128, stderr: "fatal: Needed a single revision" },
  ]);
  const r = await resolveBranchRefForVerification("claude/build-ghost", deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /git rev-parse origin\/claude\/build-ghost/);
    assert.match(r.error, /Needed a single revision/);
  }
  assert.equal(calls.length, 2);
});

test("spawn error on fetch surfaces distinctly", async () => {
  const { deps } = makeSpy([{ code: null, error: "ENOENT" }]);
  const r = await resolveBranchRefForVerification("claude/build-x", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /failed to spawn: ENOENT/);
});
