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
  BLAMELESS_OUTAGE_DEDUP_MS,
  BLAMELESS_OUTAGE_SIGNATURES,
  classifyBlamelessOutageBatch,
  decideBlamelessOutageOutcome,
  type BlamelessOutageAuditRow,
  type BlamelessOutageVerdict,
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

// ── Phase 2 — auto-resolve blameless batches, no CEO escalation, deduped ─────────────────────────
//
// Verification:
//  "A blameless-outage coach batch produces NO CEO-routed dashboard_notification and leaves no
//   needs_attention park; a re-run on the same still-outage-tainted grades does not create a new
//   card; a batch with real low grades still coaches / routes to repair / escalates exactly as
//   before."
//
// The DB writes live at the runAgentCoachJob call site; here we cover the PURE decision function
// (which the wiring dispatches on). Together with the classifier tests above, this exercises every
// branch: proceed_to_coach (Verification bullet 3) · record_blameless_outage (bullet 1) ·
// auto_resolve_deduped (bullet 2).

const BLAMELESS_VERDICT: BlamelessOutageVerdict = {
  blameless: true,
  dominantSignature: "cli_auth_failed",
  perGrade: [],
  reason: "all_3_low_grades_matched_box_outage_signature_cli_auth_failed",
};

const COACHABLE_VERDICT: BlamelessOutageVerdict = {
  blameless: false,
  dominantSignature: null,
  perGrade: [],
  reason: "low_grade_g4_carries_worker_attributable_marker",
};

test("decideBlamelessOutageOutcome: NOT blameless → proceed_to_coach (the existing coach path runs untouched — Verification bullet 3)", () => {
  const out = decideBlamelessOutageOutcome(COACHABLE_VERDICT, []);
  assert.equal(out.action, "proceed_to_coach");
  if (out.action === "proceed_to_coach") assert.equal(out.reason, COACHABLE_VERDICT.reason);
});

test("decideBlamelessOutageOutcome: blameless + no prior audit row → record_blameless_outage (no CEO card, no needs_attention — Verification bullet 1)", () => {
  const out = decideBlamelessOutageOutcome(BLAMELESS_VERDICT, []);
  assert.equal(out.action, "record_blameless_outage");
  if (out.action === "record_blameless_outage") {
    assert.equal(out.dominantSignature, "cli_auth_failed");
    assert.equal(out.reason, BLAMELESS_VERDICT.reason);
  }
});

test("decideBlamelessOutageOutcome: blameless + a recent audit row inside the dedup window → auto_resolve_deduped (Verification bullet 2)", () => {
  const now = 1_000_000_000_000;
  const recent: BlamelessOutageAuditRow[] = [
    // Just 1h old — well inside the 24h dedup window.
    { id: "audit-1", createdAt: new Date(now - 60 * 60 * 1000).toISOString() },
  ];
  const out = decideBlamelessOutageOutcome(BLAMELESS_VERDICT, recent, now);
  assert.equal(out.action, "auto_resolve_deduped");
  if (out.action === "auto_resolve_deduped") assert.equal(out.existingId, "audit-1");
});

test("decideBlamelessOutageOutcome: blameless + a STALE audit row past the dedup window → record_blameless_outage (a fresh card, not deduped)", () => {
  // A recurring outage two days later is a new outage window — mint a new audit row so the
  // dedup window doesn't silently swallow every future occurrence forever.
  const now = 1_000_000_000_000;
  const stale: BlamelessOutageAuditRow[] = [
    { id: "audit-old", createdAt: new Date(now - BLAMELESS_OUTAGE_DEDUP_MS - 1).toISOString() },
  ];
  const out = decideBlamelessOutageOutcome(BLAMELESS_VERDICT, stale, now);
  assert.equal(out.action, "record_blameless_outage");
});

test("decideBlamelessOutageOutcome: blameless + a mix of recent + stale audit rows → deduped against the recent one", () => {
  const now = 1_000_000_000_000;
  const rows: BlamelessOutageAuditRow[] = [
    { id: "audit-old", createdAt: new Date(now - BLAMELESS_OUTAGE_DEDUP_MS - 1).toISOString() },
    { id: "audit-recent", createdAt: new Date(now - 30 * 60 * 1000).toISOString() },
  ];
  const out = decideBlamelessOutageOutcome(BLAMELESS_VERDICT, rows, now);
  assert.equal(out.action, "auto_resolve_deduped");
  if (out.action === "auto_resolve_deduped") assert.equal(out.existingId, "audit-recent");
});

test("decideBlamelessOutageOutcome: blameless + an audit row with an unparseable createdAt is ignored → record_blameless_outage (never wedge on bad data)", () => {
  const rows: BlamelessOutageAuditRow[] = [{ id: "audit-junk", createdAt: "not-a-date" }];
  const out = decideBlamelessOutageOutcome(BLAMELESS_VERDICT, rows);
  assert.equal(out.action, "record_blameless_outage");
});

test("decideBlamelessOutageOutcome: blameless + verdict has null dominantSignature → record_blameless_outage with a safe fallback signature", () => {
  const v: BlamelessOutageVerdict = { ...BLAMELESS_VERDICT, dominantSignature: null };
  const out = decideBlamelessOutageOutcome(v, []);
  assert.equal(out.action, "record_blameless_outage");
  if (out.action === "record_blameless_outage") assert.equal(out.dominantSignature, "unknown_box_outage");
});

test("BLAMELESS_OUTAGE_DEDUP_MS default is 24 hours", () => {
  assert.equal(BLAMELESS_OUTAGE_DEDUP_MS, 24 * 60 * 60 * 1000);
});
