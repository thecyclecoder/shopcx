/**
 * Phase 5 of inflection-resession-must-act-on-newest-ask — the stale-resume detector pins. Ground
 * truth: parked security-review job 8040a2d9 emitted its needs-human verdict with a review text that
 * explicitly cited "No prior findings available in this session context — the previous security-review
 * run did not carry over; a human should re-trigger the review from scratch." That phrasing MUST be
 * recognized as a stale-resume failure (not a real human-needed verdict); a legit needs-human (ambiguous
 * finding that needs human context) MUST NOT be. The detector only trips on a REPAIR attempt — a fresh
 * attempt's needs-human is always real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeStaleResumeAcknowledgement,
  shouldDiscardStaleResumeVerdict,
} from "./security-stale-resume";

const SECURITY_VERDICTS: ReadonlySet<string> = new Set([
  "clean",
  "false-positive",
  "needs-human",
  "real-vuln",
]);

// ── looksLikeStaleResumeAcknowledgement — the signature detector ──
test("looksLikeStaleResumeAcknowledgement: the EXACT ground-truth tail from parked job 8040a2d9 trips", () => {
  const groundTruth =
    "No prior findings available in this session context — the previous security-review run did not carry over; a human should re-trigger the review from scratch.";
  assert.equal(looksLikeStaleResumeAcknowledgement(groundTruth), true);
});

test("looksLikeStaleResumeAcknowledgement: 'no prior findings available' alone trips", () => {
  assert.equal(
    looksLikeStaleResumeAcknowledgement("No prior findings available — session was reaped."),
    true,
  );
});

test("looksLikeStaleResumeAcknowledgement: 'did not carry over' alone trips", () => {
  assert.equal(
    looksLikeStaleResumeAcknowledgement("The previous review did not carry over into this resume."),
    true,
  );
});

test("looksLikeStaleResumeAcknowledgement: 're-trigger the review from scratch' alone trips", () => {
  assert.equal(
    looksLikeStaleResumeAcknowledgement("Please re-trigger the review from scratch to get real findings."),
    true,
  );
});

test("looksLikeStaleResumeAcknowledgement: 're-run the review from scratch' alone trips", () => {
  assert.equal(
    looksLikeStaleResumeAcknowledgement("Needs a fresh pass — re-run the review from scratch."),
    true,
  );
});

test("looksLikeStaleResumeAcknowledgement: a LEGIT ambiguous needs-human does NOT trip", () => {
  const legit =
    "The policy at src/lib/auth.ts:120 tightens tenant isolation but I cannot confirm whether the service-role bypass on line 128 is intentional without product context. A human should decide.";
  assert.equal(looksLikeStaleResumeAcknowledgement(legit), false);
});

test("looksLikeStaleResumeAcknowledgement: a clean review does NOT trip", () => {
  assert.equal(
    looksLikeStaleResumeAcknowledgement("Reviewed the diff; no injection / secret / authz / RLS regressions."),
    false,
  );
});

test("looksLikeStaleResumeAcknowledgement: empty string does NOT trip", () => {
  assert.equal(looksLikeStaleResumeAcknowledgement(""), false);
  assert.equal(looksLikeStaleResumeAcknowledgement("   "), false);
});

test("looksLikeStaleResumeAcknowledgement: non-string input does NOT throw and does NOT trip", () => {
  assert.equal(looksLikeStaleResumeAcknowledgement(null), false);
  assert.equal(looksLikeStaleResumeAcknowledgement(undefined), false);
  assert.equal(looksLikeStaleResumeAcknowledgement(123), false);
  assert.equal(looksLikeStaleResumeAcknowledgement({}), false);
});

// ── shouldDiscardStaleResumeVerdict — the guard the review-verdict loop calls ──
test("shouldDiscardStaleResumeVerdict: REPAIR + needs-human + stale-resume text → discard", () => {
  const review =
    "No prior findings available in this session context — the previous security-review run did not carry over; a human should re-trigger the review from scratch.";
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "needs-human",
      review,
      recognized: SECURITY_VERDICTS,
    }),
    true,
  );
});

test("shouldDiscardStaleResumeVerdict: FRESH attempt + needs-human + same text → KEEP (fresh is a real review)", () => {
  const review =
    "No prior findings available in this session context — the previous security-review run did not carry over; a human should re-trigger the review from scratch.";
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: false,
      verdict: "needs-human",
      review,
      recognized: SECURITY_VERDICTS,
    }),
    false,
  );
});

test("shouldDiscardStaleResumeVerdict: REPAIR + ANY needs-human → DISCARD (Phase 2 structural rule)", () => {
  // security-review-lane-must-always-produce-a-verdict Phase 2 broadened the rule: the repair prompt no
  // longer OFFERS needs-human, and a genuinely-ambiguous finding would have parsed on the FRESH attempt 1
  // (so repair is never reached for it). Therefore ANY needs-human emitted on a repair attempt is the
  // stale-resume failure — discard it so the lane re-reviews fresh. Even review text that reads like a
  // legit ambiguous call is discarded on a repair attempt.
  const review =
    "The authz check at src/lib/foo.ts:42 is ambiguous — a human familiar with the per-workspace isolation model should classify.";
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "needs-human",
      review,
      recognized: SECURITY_VERDICTS,
    }),
    true,
  );
});

test("shouldDiscardStaleResumeVerdict: REPAIR + needs-human with NO recognizable stale phrase → still DISCARD", () => {
  // The structural rule does not depend on the phrase match — a stale resume doesn't always say so.
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "needs-human",
      review: "I was unable to produce a verdict.",
      recognized: SECURITY_VERDICTS,
    }),
    true,
  );
});

test("shouldDiscardStaleResumeVerdict: REPAIR + clean verdict + stale text → KEEP (only needs-human gates)", () => {
  // A `clean` verdict is a real finding regardless of what the review text says — the detector is
  // scoped to needs-human only, so a clean/false-positive/real-vuln is never discarded.
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "clean",
      review: "No prior findings available in this session context",
      recognized: SECURITY_VERDICTS,
    }),
    false,
  );
});

test("shouldDiscardStaleResumeVerdict: recognized set without needs-human → never discard", () => {
  // If the caller lane doesn't even use `needs-human` in its recognized vocabulary (e.g. a different
  // review lane), the detector no-ops — it's security-shaped only.
  const noNeedsHuman: ReadonlySet<string> = new Set(["clean", "fail", "retry"]);
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "needs-human",
      review: "No prior findings available in this session context",
      recognized: noNeedsHuman,
    }),
    false,
  );
});

// ── Phase 2 — resolveReviewVerdict only resumes a CLEAN, NON-EMPTY attempt 1 ──
// resolveReviewVerdict is embedded in scripts/builder-worker.ts (importing it boots the worker), so this
// pins the gate via static analysis: `useRepair` must require attempt 1 exited without error and emitted
// a non-empty result. An errored / empty / timed-out attempt 1 → a FRESH review, never a --resume into a
// session with no findings.
test("resolveReviewVerdict gates the --resume on attempt 1 being clean + non-empty (no resume of a dead session)", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/builder-worker.ts", import.meta.url), "utf8"),
  );
  const fn = src.slice(src.indexOf("async function resolveReviewVerdict"));
  const body = fn.slice(0, 3500);
  assert.match(body, /const attempt1Clean/, "must compute an attempt1Clean gate");
  assert.match(body, /!last\.isError/, "attempt 1 must have exited without error to be resumed");
  assert.match(body, /last\.resultText\.trim\(\)\.length > 0/, "attempt 1 must have emitted a non-empty result to be resumed");
  assert.match(body, /const useRepair[^\n]*attempt1Clean/, "useRepair must require attempt1Clean");
});

test("the security-review repair prompt no longer offers needs-human", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../../scripts/builder-worker.ts", import.meta.url), "utf8"),
  );
  const fn = src.slice(src.indexOf("function securityReviewRepairPrompt"));
  const body = fn.slice(0, 2000);
  assert.ok(!body.includes('"status":"needs-human"'), "the repair prompt must not list a needs-human shape");
  assert.ok(!body.includes("If you genuinely could not complete"), "the repair prompt must not offer the needs-human escape");
});
