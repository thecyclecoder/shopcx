/**
 * Unit tests for `mergeContainsPhaseBuild`
 * ([[../specs/a-merge-stamps-only-the-phases-whose-code-it-actually-contains]] Phase 1).
 *
 * Pins the origin-first ancestry check that gates phase-shipped stamping:
 *   - rejects a non-hex-SHA input as an untrusted capability boundary BEFORE spawning git;
 *   - refreshes `origin/main` via `resolveBranchRefForVerification` first (one origin-first mechanism —
 *     not a second way to resolve a ref) so containment is checked against the pushed commit, not a
 *     stale local ref — the sibling defect this spec was stranded by;
 *   - runs `git merge-base --is-ancestor <buildSha> <mergeSha>`: exit 0 → contained, exit 1 → not
 *     contained, any other exit / spawn error → { ok:false, error } (FAIL-CLOSED — the caller MUST NOT
 *     stamp on an inconclusive answer).
 *
 * `runGitCmd` is injected so these tests exercise the policy without spawning git.
 *
 * Run:
 *   npx tsx --test src/lib/specs-table.merge-contains-phase-build.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeContainsPhaseBuild, type ResolveBranchRefDeps } from "@/lib/specs-table";

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

test("rejects a null buildSha WITHOUT spawning git (rule 2: no build evidence → cannot verify)", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await mergeContainsPhaseBuild("9ea6351deabcdef", null, deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe build sha/);
  assert.equal(calls.length, 0);
});

test("rejects an empty buildSha WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await mergeContainsPhaseBuild("9ea6351deabcdef", "", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe build sha/);
  assert.equal(calls.length, 0);
});

test("rejects a non-hex mergeSha WITHOUT spawning git", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await mergeContainsPhaseBuild("HEAD", "a0e1172c", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe merge sha/);
  assert.equal(calls.length, 0);
});

test("rejects a leading-dash buildSha WITHOUT spawning git (option-smuggling defence)", async () => {
  const { deps, calls } = makeSpy([]);
  const r = await mergeContainsPhaseBuild("9ea6351deabcdef", "-attack", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /refused unsafe build sha/);
  assert.equal(calls.length, 0);
});

test("refreshes origin/main first, then runs merge-base --is-ancestor with buildSha before mergeSha", async () => {
  const { deps, calls } = makeSpy([
    { code: 0 }, // fetch origin main
    { code: 0, stdout: "deadbeef\n" }, // rev-parse origin/main
    { code: 0 }, // merge-base --is-ancestor: contained
  ]);
  const r = await mergeContainsPhaseBuild("9ea6351deabcdef", "a0e1172ce", deps);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.contained, true);
  assert.equal(calls.length, 3);
  // origin-first refresh routes through resolveBranchRefForVerification("main")
  assert.deepEqual(calls[0].args, [
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  assert.deepEqual(calls[1].args, ["rev-parse", "--verify", "--quiet", "origin/main"]);
  // ancestry: buildSha (ancestor?) mergeSha (descendant?)
  assert.deepEqual(calls[2].args, ["merge-base", "--is-ancestor", "a0e1172ce", "9ea6351deabcdef"]);
});

test("merge-base exit 1 = not contained (the P2-was-null shape's positive answer for a real-but-uncarried build_sha)", async () => {
  const { deps } = makeSpy([
    { code: 0 }, // fetch
    { code: 0, stdout: "abcd\n" }, // rev-parse
    { code: 1 }, // NOT an ancestor
  ]);
  const r = await mergeContainsPhaseBuild("9ea6351d", "aaaaaaa", deps);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.contained, false);
});

test("merge-base unexpected exit fails CLOSED — the caller must NOT stamp on an inconclusive answer", async () => {
  const { deps } = makeSpy([
    { code: 0 }, // fetch
    { code: 0, stdout: "abcd\n" }, // rev-parse
    { code: 128, stderr: "fatal: Not a valid commit name aaaaaaa" }, // merge-base: unresolvable SHA
  ]);
  const r = await mergeContainsPhaseBuild("9ea6351d", "aaaaaaa", deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /git merge-base --is-ancestor aaaaaaa 9ea6351d/);
    assert.match(r.error, /Not a valid commit name/);
  }
});

test("fetch failure surfaces the git error verbatim and short-circuits the ancestry call", async () => {
  const { deps, calls } = makeSpy([
    { code: 128, stderr: "fatal: unable to access origin" },
  ]);
  const r = await mergeContainsPhaseBuild("9ea6351d", "a0e1172c", deps);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /origin\/main refresh failed/);
    assert.match(r.error, /unable to access origin/);
  }
  assert.equal(calls.length, 1, "must not call merge-base when the origin refresh failed");
});

test("spawn error on merge-base surfaces distinctly", async () => {
  const { deps } = makeSpy([
    { code: 0 }, // fetch
    { code: 0, stdout: "abcd\n" }, // rev-parse
    { code: null, error: "ENOENT" },
  ]);
  const r = await mergeContainsPhaseBuild("9ea6351d", "a0e1172c", deps);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /git merge-base failed to spawn: ENOENT/);
});
