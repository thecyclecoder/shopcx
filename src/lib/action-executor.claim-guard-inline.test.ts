/**
 * Unit tests for the claim↔action binding guard wired into the inline
 * (journey/playbook-alongside) send path — Phase 1 of the guaranteed-
 * ticket-handling goal's "Truthful actions" milestone.
 *
 * Pins the three behaviors the spec names:
 *   (a) an unbacked completed-effect claim inside a journey step is BLOCKED
 *       (sysNote + escalate; helper returns true so the outbound insert
 *       is skipped)
 *   (b) a backed claim (matching action attached) SHIPS (helper returns
 *       false; no sysNote, no escalate)
 *   (c) a THROWING evaluator ships (fail-safe — never let a guard bug block
 *       a legitimate reply)
 *
 * Run: `npx tsx --test src/lib/action-executor.claim-guard-inline.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { claimGuardBlocksInlineSend, type ActionParams } from "./action-executor";

type Recorder = { sysNotes: string[]; escalations: string[] };

function makeRecorder(): {
  rec: Recorder;
  sysNote: (m: string) => Promise<void>;
  escalate: (reason: string) => Promise<void>;
} {
  const rec: Recorder = { sysNotes: [], escalations: [] };
  return {
    rec,
    sysNote: async (m) => { rec.sysNotes.push(m); },
    escalate: async (reason) => { rec.escalations.push(reason); },
  };
}

test("(a) unbacked completed-effect claim inside a journey step is blocked + escalated", async () => {
  const { rec, sysNote, escalate } = makeRecorder();
  // Model wrote "I've cancelled your subscription" on a journey ROUTING — the
  // routing does not back a past-tense claim; nothing has actually cancelled
  // anything yet. Expected: guard fires, sysNote written, escalate called
  // with "blocked_unbacked_claim:cancel", helper returns true.
  const blocked = await claimGuardBlocksInlineSend(
    "I've cancelled your subscription — you're all set.",
    [],                              // no side actions attached
    "journey",
    "cancel_subscription",
    sysNote,
    escalate,
  );
  assert.equal(blocked, true, "helper should signal that the send is blocked");
  assert.equal(rec.escalations.length, 1);
  assert.equal(rec.escalations[0], "blocked_unbacked_claim:cancel");
  assert.equal(rec.sysNotes.length, 1);
  assert.match(rec.sysNotes[0], /\[Guard\] Blocked unbacked "cancel" claim in journey/);
});

test("(b) a backed claim (matching action attached) inside a journey step ships", async () => {
  const { rec, sysNote, escalate } = makeRecorder();
  // Model wrote "I've created a return for you — label attached" AND
  // attached a create_return side action that runs inline. Expected: the
  // guard treats create_return as backing the "return" claim → helper
  // returns false, no sysNote, no escalate, the outbound send proceeds.
  const backingActions: ActionParams[] = [{ type: "create_return", shopify_order_id: "SC00001" }];
  const blocked = await claimGuardBlocksInlineSend(
    "I've created a return for you — the label is on its way.",
    backingActions,
    "journey",
    "return_flow",
    sysNote,
    escalate,
  );
  assert.equal(blocked, false, "helper should let the send proceed when the claim is backed");
  assert.equal(rec.sysNotes.length, 0);
  assert.equal(rec.escalations.length, 0);
});

test("(c) an evaluator throw ships (fail-safe)", async () => {
  const { rec, sysNote, escalate } = makeRecorder();
  // Inject a throwing evaluator to simulate a guard-code bug. Expected: the
  // helper swallows the throw and returns false so a legitimate reply is
  // never blocked because of a defect in the guard itself.
  const throwing = () => { throw new Error("simulated guard bug"); };
  const blocked = await claimGuardBlocksInlineSend(
    "I've refunded you $20 to your card.",   // would be a hit on the real evaluator
    [],
    "journey",
    "refund_flow",
    sysNote,
    escalate,
    throwing,
  );
  assert.equal(blocked, false, "helper must fail-safe when the evaluator throws");
  assert.equal(rec.sysNotes.length, 0);
  assert.equal(rec.escalations.length, 0);
});
