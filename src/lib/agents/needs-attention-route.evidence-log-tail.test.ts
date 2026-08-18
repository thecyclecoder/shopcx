/**
 * Unit test for `evidenceLogTailSlice` — the log-tail slicer used by `routeAuthorBlocker` when it
 * turns a parked job's row into the FAILING CHECK evidence a fix session reads.
 *
 * Why this exists: Fix 1 of [[../../../docs/brain/specs/portal-remove-card-guard-rejections-are-
 * validation-not-human-escalations]] — build job 3a83a31d parked with
 * error='branch pushed but PR creation failed', and the pre-merge spec-test check's evidence read:
 *
 *     Log tail: },"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-4-7":{...
 *
 * i.e. the trailing Claude usage JSON, NOT the `ensurePr` diagnostic the earlier fix (of
 * a-merge-stamps-only-the-phases-whose-code-it-actually-contains) had already put at the START of
 * `log_tail`. The reason: `routeAuthorBlocker` was doing `.slice(-400)` on the whole log_tail, and
 * for a "branch pushed but PR creation failed" park the diagnostic lives at the HEAD (see
 * [[../pr-create-diagnostic]] `formatPrCreateFailureDiagnostic`). Slicing the TAIL drops it, so the
 * Fix session sees only Claude token counters and has nothing to act on.
 *
 * Run:
 *   npx tsx --test src/lib/agents/needs-attention-route.evidence-log-tail.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evidenceLogTailSlice } from "./needs-attention-route";

const CLAUDE_TAIL_JSON =
  '},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-4-7":{"inputTokens":11,"outputTokens":1799,' +
  '"cacheReadInputTokens":596131,"cacheCreationInputTokens":92178,"webSearchRequests":0,"costUSD":1.264875},' +
  '"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off",' +
  '"uuid":"c47536e7-146d-49f8-bca0-df6b7cf5fc22"}';

const ENSURE_PR_DIAGNOSTIC =
  "PR-create failed after 6 attempt(s) — a human should inspect the ACTUAL GitHub errors below (not the surrounding Claude usage metadata):\n" +
  "  attempt 1 (HTTP 502): {\"message\":\"Bad Gateway\"}\n" +
  "  attempt 2 (HTTP 503): {\"message\":\"Service Unavailable\"}\n" +
  "  attempt 3 (HTTP 503): {\"message\":\"Service Unavailable\"}\n" +
  "  attempt 4 (HTTP 503): {\"message\":\"Service Unavailable\"}\n" +
  "  attempt 5 (HTTP 502): {\"message\":\"Bad Gateway\"}\n" +
  "  attempt 6 (HTTP 502): {\"message\":\"Bad Gateway\"}";

const TOOLING_LOG_TAIL = `${ENSURE_PR_DIAGNOSTIC}\n\n---\n${CLAUDE_TAIL_JSON}`;

test("null / empty log_tail → the literal '(none)' placeholder", () => {
  assert.equal(evidenceLogTailSlice(null), "(none)");
  assert.equal(evidenceLogTailSlice(""), "(none)");
});

test("a short log_tail (below the budget) is returned as-is", () => {
  assert.equal(evidenceLogTailSlice("short and sweet"), "short and sweet");
});

test("a LONG log_tail without the ensurePr marker keeps the tail slice (existing behavior — real_blocker parks)", () => {
  // A real_blocker park typically has Bo's final summary at the tail, so tail-slicing is still
  // correct there. Assert that only the tooling-failure branch changes.
  const long = "a".repeat(500) + "END_OF_BO_SUMMARY";
  const out = evidenceLogTailSlice(long);
  assert.equal(out.endsWith("END_OF_BO_SUMMARY"), true, `tail slice should still preserve trailing summary, got ${out.slice(-40)}`);
});

test("REGRESSION — a tooling-failure log_tail (diagnostic at the HEAD) surfaces the diagnostic, NOT the trailing Claude JSON", () => {
  // The exact failing state from Fix 1: the diagnostic sits at the head of log_tail, and the
  // pre-fix `.slice(-400)` dropped it entirely. The slicer MUST surface the diagnostic — that is
  // the whole point of `formatPrCreateFailureDiagnostic` capturing per-attempt HTTP status + body.
  const out = evidenceLogTailSlice(TOOLING_LOG_TAIL);
  assert.equal(
    out.startsWith("PR-create failed after"),
    true,
    `expected the ensurePr diagnostic at the start of the evidence slice; got: ${out.slice(0, 80)}…`,
  );
  assert.equal(
    out.includes("HTTP 502"),
    true,
    "expected at least one concrete GitHub HTTP status in the evidence slice",
  );
  assert.equal(
    /modelUsage.*claude-opus-4-7/.test(out),
    false,
    "the Claude usage metadata block must NOT dominate the evidence — the actual failure does",
  );
});

test("the returned evidence slice never exceeds the budget", () => {
  const long = "PR-create failed after 6 attempt(s)\n" + "x".repeat(4000);
  const out = evidenceLogTailSlice(long);
  assert.ok(out.length <= 400, `slice length ${out.length} exceeded the 400-char budget`);
});
