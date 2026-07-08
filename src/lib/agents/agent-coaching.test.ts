/**
 * Unit tests for agent-coach-auto-resolves-blameless-box-outage-grade-batches-instead-of-escalating
 * Phase 1 — the pure blameless-box-outage classifier in `src/lib/agents/agent-coaching.ts`. Node's
 * built-in test runner, no Supabase / LLM stubs — `classifyBlamelessOutageBatch` is a pure fn over
 * the (grade reasoning + job error + log tail) triple.
 *
 *   npm run test:agent-coaching
 *   (= tsx --test src/lib/agents/agent-coaching.test.ts)
 *
 * Covers the spec's Phase 1 Verification bullet:
 *   "A batch where all N low grades carry the box-level auth-outage / breaker signature classifies
 *    as blameless-outage; a batch with even one genuine worker-attributable low grade does NOT."
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLAMELESS_OUTAGE_SIGNATURES,
  classifyBlamelessOutageBatch,
  type CoachBatchLowGrade,
} from "./agent-coaching";

function outageLow(id: string, phrase: string): CoachBatchLowGrade {
  return { gradeId: id, gradeReasoning: `worker failed: ${phrase}`, jobError: phrase, jobLogTail: null };
}

test("classifyBlamelessOutageBatch: empty batch is NOT blameless (nothing to auto-resolve)", () => {
  const v = classifyBlamelessOutageBatch([]);
  assert.equal(v.blameless, false);
  assert.equal(v.reason, "empty_batch");
});

test("classifyBlamelessOutageBatch: every low grade matches one box-outage signature → blameless", () => {
  const lows: CoachBatchLowGrade[] = [
    outageLow("g1", "authentication_failed"),
    outageLow("g2", "Not logged in"),
    outageLow("g3", "Claude is down (breaker tripped) — auto-resumes on recovery"),
  ];
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, true, `expected blameless, got reason=${v.reason}`);
  assert.ok(v.dominantSignature, "dominantSignature must be set on a blameless verdict");
  assert.equal(v.perGrade.length, 3);
  for (const g of v.perGrade) assert.ok(g.matchedSignature, `grade ${g.gradeId} must match a box-outage signature`);
});

test("classifyBlamelessOutageBatch: EVERY signature in BLAMELESS_OUTAGE_SIGNATURES actually matches its own key example", () => {
  // Guard against a regex being weakened / mis-anchored later — each entry must at minimum match
  // a canonical example carrying the same key name.
  const canonical: Record<string, string> = {
    cli_auth_failed: "authentication_failed",
    cli_not_logged_in: "Not logged in",
    cli_login_prompt: "Please run /login",
    claude_breaker_tripped: "Claude is down (breaker tripped) — auto-resumes on recovery",
    breaker_tripped: "breaker tripped",
    blocked_on_dependency_claude: "job parked blocked_on_dependency — Claude is down",
  };
  for (const s of BLAMELESS_OUTAGE_SIGNATURES) {
    const ex = canonical[s.key];
    assert.ok(ex, `no canonical example for signature key ${s.key}`);
    assert.equal(s.pattern.test(ex), true, `signature ${s.key} must match example "${ex}"`);
  }
});

test("classifyBlamelessOutageBatch: identical box-level error across every low grade → blameless (dominant signature is the shared one)", () => {
  // A run-window outage stamps THE SAME error onto every action — one dominant signature.
  const lows: CoachBatchLowGrade[] = Array.from({ length: 4 }, (_, i) =>
    outageLow(`g${i + 1}`, "authentication_failed — CLAUDE_CONFIG_DIR credentials expired"),
  );
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, true);
  assert.equal(v.dominantSignature, "cli_auth_failed");
});

test("classifyBlamelessOutageBatch: even ONE low grade with a genuine worker-attributable slip (co-occurring with an outage signal) → NOT blameless", () => {
  // Three clean outages + one grade whose text ALSO carries the outage phrase but records a real
  // worker slip on top of it. The worker-attributable marker must win — a real slip can't be
  // masked by an outage co-occurrence. This is the false-positive the spec exists to prevent.
  const lows: CoachBatchLowGrade[] = [
    outageLow("g1", "authentication_failed"),
    outageLow("g2", "Not logged in"),
    outageLow("g3", "Claude is down (breaker tripped)"),
    {
      gradeId: "g4",
      // Outage phrase present so signature-match passes, but reasoning names a real slip.
      gradeReasoning:
        "the worker mis-diagnosed the root cause — flagged a symptom, not root cause (`breaker tripped` co-occurred but the worker's earlier turn wrote the wrong disposition)",
      jobError: null,
      jobLogTail: null,
    },
  ];
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, false, `expected NOT blameless, got reason=${v.reason}`);
  assert.match(v.reason, /worker_attributable_marker/);
});

test("classifyBlamelessOutageBatch: even ONE low grade whose text has NO box-outage signature AT ALL → NOT blameless (the missing-signature branch, separate from the worker-marker branch)", () => {
  // Two clean outages + one grade that carries neither a box signature NOR a worker marker
  // (a bare `tsc failed` line). The batch is NOT blameless — the classifier defaults to
  // "coachable" whenever a grade doesn't clearly match the box-infra vocabulary.
  const lows: CoachBatchLowGrade[] = [
    outageLow("g1", "authentication_failed"),
    outageLow("g2", "Not logged in"),
    { gradeId: "g3", gradeReasoning: "tsc failed on the merged diff", jobError: "tsc failed", jobLogTail: null },
  ];
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, false);
  assert.match(v.reason, /matched_no_box_outage_signature/);
});

test("classifyBlamelessOutageBatch: a Claude-breaker park signal on the job error alone (grader reasoning empty) still classifies as blameless when the whole batch shares it", () => {
  // The park sweep writes `error: 'Claude is down (breaker tripped) — auto-resumes on recovery'`
  // onto the agent_jobs row directly; the grader reasoning may just paraphrase "worker failed with
  // no output" without repeating the breaker phrase. The classifier reads BOTH — grade reasoning
  // OR job error — so a batch of these still classifies as blameless.
  const lows: CoachBatchLowGrade[] = [
    { gradeId: "g1", gradeReasoning: "worker failed with no output", jobError: "Claude is down (breaker tripped) — auto-resumes on recovery", jobLogTail: null },
    { gradeId: "g2", gradeReasoning: "worker failed with no output", jobError: "Claude is down (breaker tripped) — auto-resumes on recovery", jobLogTail: null },
  ];
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, true);
  assert.equal(v.dominantSignature, "claude_breaker_tripped");
});

test("classifyBlamelessOutageBatch: a log-tail-only match still counts (the signature travels wherever the CLI wrote it)", () => {
  // The Claude CLI's `Not logged in` message may only survive in log_tail (the stream-json result
  // event was killed before it could serialize) — the classifier reads log_tail too.
  const lows: CoachBatchLowGrade[] = [
    { gradeId: "g1", gradeReasoning: null, jobError: null, jobLogTail: "some prelude ...\nNot logged in — run /login to authenticate\n" },
  ];
  const v = classifyBlamelessOutageBatch(lows);
  assert.equal(v.blameless, true);
  assert.equal(v.dominantSignature, "cli_not_logged_in");
});
