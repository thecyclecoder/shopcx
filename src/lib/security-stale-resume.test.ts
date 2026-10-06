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

test("shouldDiscardStaleResumeVerdict: REPAIR + legit human-needed verdict → KEEP", () => {
  const review =
    "The authz check at src/lib/foo.ts:42 is ambiguous — a human familiar with the per-workspace isolation model should classify.";
  assert.equal(
    shouldDiscardStaleResumeVerdict({
      useRepair: true,
      verdict: "needs-human",
      review,
      recognized: SECURITY_VERDICTS,
    }),
    false,
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
