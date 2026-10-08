/**
 * Phase 1 of docs/brain/specs/playbooks-survive-merge-guard-teasers-watchdog-catches-stalls.md.
 *
 * The named failing state: before this phase the Sol first-touch dispatch predicate
 * (unified-ticket-handler § 3.95) only checked `isNew && sol_first_touch_enabled &&
 * !agentAssigned && msgType !== "outreach"`. When auto-merge carried a running playbook
 * into a brand-new ticket, the turn was still treated as a first touch and a full Sol
 * session ran instead of the playbook continuing (ticket ccb423fe, Angelica Devine,
 * 2026-10-08). The fix adds `!inheritedActivePlaybook` to the predicate.
 *
 *   npx tsx --test src/lib/first-touch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldDispatchSolFirstTouch } from "./first-touch";

const base = {
  isNew: true,
  solFirstTouchEnabled: true,
  agentAssigned: false,
  msgType: "account" as const,
  inheritedActivePlaybook: false,
};

test("new account ticket with no inherited playbook → Sol first-touch dispatches", () => {
  assert.equal(shouldDispatchSolFirstTouch(base), true);
});

test("new ticket that inherited a running playbook via merge → NO Sol dispatch", () => {
  assert.equal(
    shouldDispatchSolFirstTouch({ ...base, inheritedActivePlaybook: true }),
    false,
  );
});

test("existing ticket never takes the first-touch path", () => {
  assert.equal(shouldDispatchSolFirstTouch({ ...base, isNew: false }), false);
});

test("channel not opted into Sol first-touch → no dispatch", () => {
  assert.equal(
    shouldDispatchSolFirstTouch({ ...base, solFirstTouchEnabled: false }),
    false,
  );
});

test("agent already handling the ticket → no dispatch", () => {
  assert.equal(shouldDispatchSolFirstTouch({ ...base, agentAssigned: true }), false);
});

test("outreach bucket → no dispatch", () => {
  assert.equal(shouldDispatchSolFirstTouch({ ...base, msgType: "outreach" }), false);
});
