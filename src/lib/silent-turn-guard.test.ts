/**
 * Unit tests for `detectSilentTurn` — the pure predicate the unified ticket handler calls after
 * an exec-playbook-step turn to decide whether to run the escalate_api_failure holding-message +
 * Slack path so no customer is ever left in silence.
 *
 * Mirrors the Phase-2 verification bullet of
 * docs/brain/specs/post-resolution-inbound-reroute-and-silent-turn-guard.md — the silent-turn
 * escape hatch sends a holding message on (a) a dead-playbook-resume and (b) a failed subscription
 * mutation inside the playbook.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/silent-turn-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSilentTurn,
  SILENT_TURN_HOLDING_MESSAGE,
} from "./silent-turn-guard";

test("response sent → not silent (customer heard back)", () => {
  const verdict = detectSilentTurn({
    responseSent: true,
    escalationRaised: false,
    cancelled: false,
    finalAction: "respond",
    finalError: null,
  });
  assert.equal(verdict.silent, false);
});

test("escalation already raised → not silent (existing rail sent holding message)", () => {
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: true,
    cancelled: false,
    finalAction: "escalate_api_failure",
    finalError: "appstle 503",
  });
  assert.equal(verdict.silent, false);
});

test("cancelled by newer inbound → not silent (a fresh turn will run)", () => {
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: true,
    finalAction: null,
    finalError: null,
  });
  assert.equal(verdict.silent, false);
});

test("dead playbook resume — silent complete with no reply → dead_playbook_resume", () => {
  // Melissa/eca3f43b: stale refund playbook resumed post-June-resolution, ran to complete,
  // sent nothing back. The runtime guard catches it before the customer waits in silence.
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: false,
    finalAction: "complete",
    finalError: null,
  });
  assert.equal(verdict.silent, true);
  if (verdict.silent) {
    assert.equal(verdict.reason, "dead_playbook_resume");
    assert.match(verdict.note, /complete/);
    assert.match(verdict.note, /no customer-facing response/);
  }
});

test("MAX_AUTO_ADVANCE ceiling hit with no reply → dead_playbook_resume", () => {
  // A degenerate playbook whose auto-advance loop hits its safety ceiling with no response
  // is the same silent class as a bare complete — the customer heard nothing.
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: false,
    finalAction: "advance",
    finalError: null,
  });
  assert.equal(verdict.silent, true);
  if (verdict.silent) {
    assert.equal(verdict.reason, "dead_playbook_resume");
    assert.match(verdict.note, /advance/);
  }
});

test("failed subscription mutation with error string but no reply → playbook_mutation_failed", () => {
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: false,
    finalAction: "complete",
    finalError: "appstle contract cancel returned 500",
  });
  assert.equal(verdict.silent, true);
  if (verdict.silent) {
    assert.equal(verdict.reason, "playbook_mutation_failed");
    assert.match(verdict.note, /appstle contract cancel returned 500/);
    assert.match(verdict.note, /no response/);
  }
});

test("whitespace-only error string → treated as no error → dead_playbook_resume", () => {
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: false,
    finalAction: "complete",
    finalError: "   \t\n",
  });
  assert.equal(verdict.silent, true);
  if (verdict.silent) assert.equal(verdict.reason, "dead_playbook_resume");
});

test("very-long error is truncated to keep the sysNote/Slack payload readable", () => {
  const huge = "x".repeat(1000);
  const verdict = detectSilentTurn({
    responseSent: false,
    escalationRaised: false,
    cancelled: false,
    finalAction: "complete",
    finalError: huge,
  });
  assert.equal(verdict.silent, true);
  if (verdict.silent) {
    assert.equal(verdict.reason, "playbook_mutation_failed");
    assert.ok(verdict.note.length < 400, "note should be capped");
  }
});

test("holding-message string is the stable escalate_api_failure copy", () => {
  // Regression pin: the runtime guard sends the byte-identical string the existing
  // escalate_api_failure rail sends, so a customer never sees two different holding messages.
  assert.equal(
    SILENT_TURN_HOLDING_MESSAGE,
    "I need a little time to work on this and I'll get back to you.",
  );
});
