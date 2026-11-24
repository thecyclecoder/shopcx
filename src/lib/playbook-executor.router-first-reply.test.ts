/**
 * Phase 1 of docs/brain/specs/playbook-takeover-replies-and-clears-escalation.md —
 * the intent→playbook router sends the playbook's FIRST reply this turn and auto-advances.
 *
 * Ground truth: Juliana Fradlis (22be5796) and Doreen Johnson (b5aaff03) both sat escalated
 * on the Refund playbook at step 1 with NO reply sent — `routeIntentToPlaybook` ran
 * `executePlaybookStep` and DISCARDED the result, so nothing shipped. The fix threads that
 * result back to the caller and `deliverRoutedPlaybookFirstReply` ships it + auto-advances
 * through the silent steps until one responds, exactly like the main playbook branch.
 *
 * Models the Refund playbook: step 0 resolves silently (advance), steps 1-3 advance, and
 * step 4 renders the policy reply. The CORRECT state is ONE outbound reply at playbook_step 4.
 *
 * Run: npx tsx --test src/lib/playbook-executor.router-first-reply.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deliverRoutedPlaybookFirstReply, type PlaybookExecResult } from "./playbook-executor";

test("a refund_request on a fresh ticket yields one outbound policy reply and playbook_step 4", async () => {
  // step 0 (executed inside routeIntentToPlaybook) advanced silently.
  const first: PlaybookExecResult = { action: "advance", systemNote: "[System] Starting Refund playbook." };
  // steps 1 → 2 → 3 advance silently; step 4 renders the policy reply.
  const seq: PlaybookExecResult[] = [
    { action: "advance" },
    { action: "advance" },
    { action: "advance" },
    { action: "respond", response: "Per our 30-day policy here's what we can do." },
  ];
  let playbookStep = 0; // mirrors tickets.playbook_step as each step executes
  const sent: string[] = [];

  const delivery = await deliverRoutedPlaybookFirstReply({
    first,
    sendReply: async (b) => {
      sent.push(b);
    },
    postSysNote: async () => {},
    execNextStep: async () => {
      const res = seq[playbookStep];
      playbookStep++;
      return res;
    },
  });

  assert.equal(sent.length, 1, "exactly one outbound policy reply is sent");
  assert.equal(sent[0], "Per our 30-day policy here's what we can do.");
  assert.equal(playbookStep, 4, "auto-advanced through to playbook_step 4");
  assert.equal(delivery.repliesSent, 1);
  assert.equal(delivery.finalAction, "respond");
});

test("the first step's own reply is sent and NOT double-sent by the auto-advance loop", async () => {
  // step 0 itself responds (no advance) — the common single-step playbook case.
  const first: PlaybookExecResult = { action: "respond", response: "Here's your refund." };
  let calls = 0;
  const sent: string[] = [];

  const delivery = await deliverRoutedPlaybookFirstReply({
    first,
    sendReply: async (b) => {
      sent.push(b);
    },
    postSysNote: async () => {},
    execNextStep: async () => {
      calls++;
      return { action: "complete" };
    },
  });

  assert.equal(sent.length, 1, "the step-0 reply is sent exactly once");
  assert.equal(calls, 0, "no auto-advance step runs when step 0 already responded");
  assert.equal(delivery.finalAction, "respond");
});

test("the auto-advance loop honors the cap and the beforeStep guard", async () => {
  // A silent-advance run that never responds stops at the cap instead of looping forever.
  const first: PlaybookExecResult = { action: "advance" };
  let calls = 0;
  const delivery = await deliverRoutedPlaybookFirstReply({
    first,
    sendReply: async () => {},
    postSysNote: async () => {},
    execNextStep: async () => {
      calls++;
      return { action: "advance" };
    },
    maxAutoAdvance: 3,
  });
  assert.equal(calls, 3, "stops at the auto-advance cap");
  assert.equal(delivery.repliesSent, 0);

  // beforeStep returning false (e.g. newer inbound activity) halts before the next step.
  let calls2 = 0;
  await deliverRoutedPlaybookFirstReply({
    first: { action: "advance" },
    sendReply: async () => {},
    postSysNote: async () => {},
    execNextStep: async () => {
      calls2++;
      return { action: "advance" };
    },
    beforeStep: async () => false,
  });
  assert.equal(calls2, 0, "beforeStep=false halts the loop before any step runs");
});
