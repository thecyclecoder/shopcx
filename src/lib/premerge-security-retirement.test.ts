/**
 * Non-destructive regression tests for [[fused-premerge-security-authoritative-drop-standalone]] Phase 3.
 * Pins:
 *
 *   1. `maybeEnqueuePreMergeSecurityOnAccumulation` is RETIRED — for ANY inputs it returns
 *      `{ enqueued: false, reason: /retired/i }` without touching the DB (proves no branch-mode
 *      `enqueueSecurityReviewJob` call from any legacy caller).
 *   2. The security leg of `backstopPreMergeChecks` is GONE — grep-check that the retired-function's
 *      name no longer appears inside the backstop function body in `src/lib/agent-jobs.ts` (any
 *      reintroduction fails the test — the whole point of the Phase-3 verification bullet).
 *   3. The post-merge `diff` mode + `dep-watch` calls to `enqueueSecurityReviewJob` are UNTOUCHED —
 *      grep confirms both are still present in `src/lib/agent-jobs.ts` (the retirement scoped
 *      STRICTLY to pre-merge BRANCH mode).
 *
 * Pure — no DB, no network. Run:
 *   npm run test:premerge-security-retirement
 *   (= tsx --test src/lib/premerge-security-retirement.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { maybeEnqueuePreMergeSecurityOnAccumulation } from "./agent-jobs";

const AGENT_JOBS_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./agent-jobs.ts"),
  "utf8",
);

test("maybeEnqueuePreMergeSecurityOnAccumulation: RETIRED — always returns {enqueued:false, reason: /retired/i}", async () => {
  // Any inputs — including a fully-populated preview-ready shape — must no-op.
  const cases = [
    { workspaceId: "ws1", slug: "some-spec", branch: "claude/build-some-spec", previewUrl: "https://foo.vercel.app", prNumber: 42 },
    { workspaceId: "ws1", slug: "s", branch: null, previewUrl: null },
    { workspaceId: "", slug: "", branch: "claude/x", previewUrl: "" },
  ];
  for (const args of cases) {
    const r = await maybeEnqueuePreMergeSecurityOnAccumulation(args);
    assert.equal(r.enqueued, false, `enqueued must be false for args=${JSON.stringify(args)}`);
    assert.match(String(r.reason ?? ""), /retired/i, "reason must mention retirement");
  }
});

test("backstopPreMergeChecks: security leg REMOVED — no call to maybeEnqueuePreMergeSecurityOnAccumulation from the backstop body", () => {
  // Isolate the backstopPreMergeChecks function body and grep — the retired function's identifier must
  // not appear inside it. (The function IS still defined + exported at the top of the file; the point
  // is that the backstop no longer INVOKES it — a reintroduction would fail this test.)
  const startMarker = "export async function backstopPreMergeChecks(";
  const startIdx = AGENT_JOBS_SRC.indexOf(startMarker);
  assert.notEqual(startIdx, -1, "backstopPreMergeChecks not found in agent-jobs.ts");
  const afterStart = AGENT_JOBS_SRC.slice(startIdx);
  // Find the balanced closing brace of the function (bounded scan — the next `\n}\n` line at column 0 is the closer).
  const bodyEndRel = afterStart.search(/\n}\n/);
  assert.notEqual(bodyEndRel, -1, "could not locate backstopPreMergeChecks body end");
  const body = afterStart.slice(0, bodyEndRel + 2);
  assert.equal(
    body.includes("maybeEnqueuePreMergeSecurityOnAccumulation("),
    false,
    "backstopPreMergeChecks must NOT call maybeEnqueuePreMergeSecurityOnAccumulation (Phase 3 removed the security leg)",
  );
});

test("post-merge `diff` mode + `dep-watch` calls to enqueueSecurityReviewJob are UNTOUCHED (retirement scoped to pre-merge branch mode)", () => {
  // The post-merge merge-hook path (applyMergedBuildEffects) still calls enqueueSecurityReviewJob
  // with { mergeSha } — that's the `diff` mode + dep-watch path the spec explicitly PRESERVES.
  assert.equal(
    AGENT_JOBS_SRC.includes("mergeSha: opts.mergeSha"),
    true,
    "post-merge diff-mode enqueueSecurityReviewJob call must still be present",
  );
  // The overall enqueueSecurityReviewJob symbol is still imported/used elsewhere for diff/dep-watch.
  assert.equal(
    AGENT_JOBS_SRC.includes("enqueueSecurityReviewJob"),
    true,
    "enqueueSecurityReviewJob must still be referenced (diff / dep-watch remain)",
  );
});

test("retired function's implementation body no longer imports/calls enqueueSecurityReviewJob (proof the branch-mode enqueue is unreachable from it)", () => {
  const startMarker = "export async function maybeEnqueuePreMergeSecurityOnAccumulation(";
  const startIdx = AGENT_JOBS_SRC.indexOf(startMarker);
  assert.notEqual(startIdx, -1, "maybeEnqueuePreMergeSecurityOnAccumulation not found in agent-jobs.ts");
  const afterStart = AGENT_JOBS_SRC.slice(startIdx);
  const bodyEndRel = afterStart.search(/\n}\n/);
  assert.notEqual(bodyEndRel, -1, "could not locate retired function body end");
  const body = afterStart.slice(0, bodyEndRel + 2);
  assert.equal(
    body.includes("enqueueSecurityReviewJob"),
    false,
    "retired function body must not reference enqueueSecurityReviewJob (Phase 3 no-op)",
  );
});
