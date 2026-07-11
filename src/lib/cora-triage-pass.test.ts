/**
 * Unit test for the cheap triage pass's PURE helpers — `buildTriagePrompt` (prompt shape) and
 * `parseTriageResult` (recall-biased parser). No Anthropic call, no DB. Pins two invariants the
 * founder locked:
 *   1. The classifier judges TERMINAL state, not the messy middle (prompt wording).
 *   2. The gate is recall-biased — an unparseable / contradictory result FAILS OPEN to a deep
 *      review (needsReview=true), it never silently clears a ticket it couldn't read.
 *
 * Run:
 *   npx tsx --test src/lib/cora-triage-pass.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTriagePrompt, parseTriageResult, renderTranscript, TRIAGE_SIGNALS } from "./cora-triage-pass";

// subject-blind-grader: email customers routinely put the whole ask in the SUBJECT ("PLEASE Cancel
// my Subscription!!!") and leave a footer-only body. The grader must see the subject or a correct
// reply (Sol reads the subject → sends the cancel journey) looks like a non-sequitur and grades ~1.
test("renderTranscript surfaces the subject as the first line (the ask lives there)", () => {
  const t = renderTranscript(
    [{ direction: "inbound", author_type: "customer", visibility: "external", body: "Sent from my iPhone", body_clean: "Sent from my iPhone" }],
    "PLEASE Cancel my Subscription!!!!!!!!",
  );
  assert.match(t, /^SUBJECT: PLEASE Cancel my Subscription/);
});

test("renderTranscript yields a gradeable transcript even when the BODY is a footer-only non-request", () => {
  // The 5ed8270a case: subject carries the ask, body is just a disclaimer footer.
  const t = renderTranscript(
    [
      { direction: "inbound", author_type: "customer", visibility: "external", body: "This e-mail is intended solely for the addressee.", body_clean: "This e-mail is intended solely for the addressee." },
      { direction: "outbound", author_type: "ai", visibility: "external", body: "We'd hate to see you go — click below to cancel.", body_clean: "We'd hate to see you go — click below to cancel." },
    ],
    "Cancel my subscription",
  );
  assert.match(t, /SUBJECT: Cancel my subscription/);
  assert.match(t, /AGENT: We'd hate to see you go/);
});

test("renderTranscript omits the SUBJECT line when there is no subject", () => {
  const t = renderTranscript(
    [{ direction: "inbound", author_type: "customer", visibility: "external", body: "where is my order", body_clean: "where is my order" }],
    null,
  );
  assert.ok(!t.includes("SUBJECT:"));
  assert.match(t, /CUSTOMER: where is my order/);
});

test("prompt tells the classifier the ask may be in the SUBJECT line", () => {
  const { system } = buildTriagePrompt("SUBJECT: cancel\nCUSTOMER: (footer)");
  assert.match(system, /SUBJECT/);
});

test("prompt keys on TERMINAL state, not the messy middle", () => {
  const { system, user } = buildTriagePrompt("CUSTOMER: hi\nAGENT: hello");
  assert.match(system, /TERMINAL STATE|ENDED|ENDING/);
  assert.match(system, /RECOVERED/); // the mid-turn-stumble-is-fine carve-out
  assert.match(system, /unsure/i); // recall bias baked into the prompt
  assert.ok(user.includes("CUSTOMER: hi"), "transcript is embedded in the user turn");
});

test("parses a clean pass (needs_review=false, no signals)", () => {
  const r = parseTriageResult('{"needs_review": false, "signals": [], "score": 9, "summary": "resolved cleanly"}');
  assert.equal(r.needsReview, false);
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.coachingSignals, []);
  assert.equal(r.score, 9);
  assert.equal(r.summary, "resolved cleanly");
});

test("clean ending + recovered messy middle → no review, but coaching_signals surface", () => {
  const r = parseTriageResult(
    '{"needs_review": false, "signals": [], "coaching_signals": ["contradiction_recovered", "slow_resolution", "bogus"], "score": 7, "summary": "resolved but bumpy"}',
  );
  assert.equal(r.needsReview, false); // recovered messy middle NEVER escalates
  assert.deepEqual(r.signals, []);
  assert.deepEqual(r.coachingSignals, ["contradiction_recovered", "slow_resolution"]); // 'bogus' dropped
});

test("prompt elicits coaching_signals separate from terminal signals", () => {
  const { system } = buildTriagePrompt("CUSTOMER: hi\nAGENT: hello");
  assert.match(system, /coaching_signals/);
  assert.match(system, /RECOVERED/);
});

test("parses a flagged pass and keeps only known signals", () => {
  const r = parseTriageResult(
    '{"needs_review": true, "signals": ["unkept_promise", "made_up_signal"], "score": 3, "summary": "promised a refund that never fired"}',
  );
  assert.equal(r.needsReview, true);
  assert.deepEqual(r.signals, ["unkept_promise"]); // made_up_signal dropped
  assert.equal(r.score, 3);
});

test("tolerates prose around the JSON object", () => {
  const r = parseTriageResult('Sure!\n{"needs_review": true, "signals": [], "score": 4, "summary": "unsure"}\nHope that helps.');
  assert.equal(r.needsReview, true);
});

test("FAILS OPEN on unparseable text", () => {
  const r = parseTriageResult("the model refused and wrote a paragraph with no json");
  assert.equal(r.needsReview, true);
  assert.deepEqual(r.signals, ["parse_error"]);
});

test("FAILS OPEN on empty / null-ish input", () => {
  assert.equal(parseTriageResult("").needsReview, true);
  assert.equal(parseTriageResult("{}").needsReview, true); // no needs_review field
});

test("FAILS OPEN on a contradictory verdict (clean but with signals)", () => {
  const r = parseTriageResult('{"needs_review": false, "signals": ["wrong_outcome"], "score": 8, "summary": "?"}');
  assert.equal(r.needsReview, true);
  assert.deepEqual(r.signals, ["parse_error"]);
});

test("clamps score to 1-10 and rounds", () => {
  assert.equal(parseTriageResult('{"needs_review": false, "signals": [], "score": 42}').score, 10);
  assert.equal(parseTriageResult('{"needs_review": false, "signals": [], "score": -3}').score, 1);
  assert.equal(parseTriageResult('{"needs_review": false, "signals": [], "score": 7.6}').score, 8);
  // Omitted score → middling 5.
  assert.equal(parseTriageResult('{"needs_review": false, "signals": []}').score, 5);
});

test("every declared TRIAGE_SIGNAL is a terminal-state failure mode (documentation guard)", () => {
  // A recovered mid-journey stumble must NOT be in the set — the whole point of the pass.
  assert.ok(!TRIAGE_SIGNALS.includes("mid_turn_error" as never));
  assert.ok(TRIAGE_SIGNALS.includes("customer_unresolved"));
  assert.ok(TRIAGE_SIGNALS.includes("false_outcome_claim"));
});
