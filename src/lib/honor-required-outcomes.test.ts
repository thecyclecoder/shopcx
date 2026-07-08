/**
 * Unit tests for the Phase-2 honor step (docs/brain/specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified.md § Phase 2).
 *
 * Focus: the failing state from ticket 0a9e4d7f (Judy) — the reply claimed
 * "added a 2nd bag + applied $15 credit" while neither action actually ran.
 * The Phase-2 invariant is:
 *   1. `decideOutcome` folds handler + verify into a single verdict — a failure
 *      at either step lands as `failed` so the send guard's terminal-status
 *      check stays a one-line predicate.
 *   2. `replyGateBlocked` is blocked while ANY row is not `verified` (pending,
 *      done, and failed all count as "not ship-worthy").
 *   3. Ordering: the honor step must decide every item BEFORE the reply gate
 *      ever opens. This test drives a Judy-shaped scenario and asserts the
 *      event order.
 *
 * Run:
 *   npx tsx --test src/lib/honor-required-outcomes.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ActionParams, ActionResult } from "./action-executor";
import type { TicketRequiredOutcome } from "./ticket-required-outcomes";
import {
  decideOutcome,
  replyGateBlocked,
  outcomeToActionParams,
  honorSummaryToLedgerOutcome,
} from "./honor-required-outcomes";

function fakeOutcome(overrides: Partial<TicketRequiredOutcome>): TicketRequiredOutcome {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspace_id: "w",
    ticket_id: "t",
    direction_id: null,
    kind: "noop",
    description: "noop",
    target_ids: {},
    expected_db_state: {},
    status: "pending",
    resolution_event_id: null,
    verified_at: null,
    failed_reason: null,
    authored_by: "test",
    authored_at: new Date(0).toISOString(),
    ...overrides,
  };
}

// ── decideOutcome ────────────────────────────────────────────────────────

test("decideOutcome: handler success + verify=true → verified", async () => {
  const decision = await decideOutcome(
    { type: "apply_coupon", contract_id: "gid://x", code: "JUDY15" } as ActionParams,
    async () => ({ success: true }),
    async () => true,
  );
  assert.deepEqual(decision, { verdict: "verified" });
});

test("decideOutcome: handler success + verify=false → failed with 'did not confirm' (Judy's $15 credit shape)", async () => {
  const decision = await decideOutcome(
    { type: "apply_coupon", contract_id: "gid://x", code: "JUDY15" } as ActionParams,
    async () => ({ success: true }),
    async () => false,
  );
  assert.equal(decision.verdict, "failed");
  assert.match((decision as { reason: string }).reason, /did not confirm/);
});

test("decideOutcome: handler returns success=false → failed with handler error propagated", async () => {
  const decision = await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => ({ success: false, error: "coupon code invalid" }),
    async () => true,
  );
  assert.equal(decision.verdict, "failed");
  assert.equal((decision as { reason: string }).reason, "coupon code invalid");
});

test("decideOutcome: handler returns success=false with no error → failed with default reason", async () => {
  const decision = await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => ({ success: false }),
    async () => true,
  );
  assert.equal(decision.verdict, "failed");
  assert.equal((decision as { reason: string }).reason, "handler returned success=false");
});

test("decideOutcome: handler throws → failed with thrown message", async () => {
  const decision = await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => { throw new Error("network glitch"); },
    async () => true,
  );
  assert.equal(decision.verdict, "failed");
  assert.match((decision as { reason: string }).reason, /handler threw: network glitch/);
});

test("decideOutcome: verify throws → failed with thrown message (dispatch was OK)", async () => {
  let dispatched = false;
  const decision = await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => { dispatched = true; return { success: true }; },
    async () => { throw new Error("supabase down"); },
  );
  assert.equal(dispatched, true, "dispatch must have completed before verify throws");
  assert.equal(decision.verdict, "failed");
  assert.match((decision as { reason: string }).reason, /verify threw: supabase down/);
});

test("decideOutcome: verify runs AFTER dispatch (ordering)", async () => {
  const events: string[] = [];
  await decideOutcome(
    { type: "add_bag_to_next_order" } as ActionParams,
    async () => { events.push("dispatched"); return { success: true }; },
    async () => { events.push("verified"); return true; },
  );
  assert.deepEqual(events, ["dispatched", "verified"]);
});

test("decideOutcome: verify is NEVER called if dispatch returned success=false", async () => {
  let verifyCalled = false;
  await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => ({ success: false, error: "no such code" }),
    async () => { verifyCalled = true; return true; },
  );
  assert.equal(verifyCalled, false, "verify must be skipped when the handler already failed");
});

test("decideOutcome: verify is NEVER called if dispatch threw", async () => {
  let verifyCalled = false;
  await decideOutcome(
    { type: "apply_coupon" } as ActionParams,
    async () => { throw new Error("boom"); },
    async () => { verifyCalled = true; return true; },
  );
  assert.equal(verifyCalled, false, "verify must be skipped when the handler threw");
});

// ── replyGateBlocked ─────────────────────────────────────────────────────

test("replyGateBlocked: empty list → NOT blocked (a ticket with no required outcomes can reply freely)", () => {
  const g = replyGateBlocked([]);
  assert.equal(g.blocked, false);
  assert.equal(g.verified_count, 0);
});

test("replyGateBlocked: all rows verified → NOT blocked", () => {
  const g = replyGateBlocked([
    fakeOutcome({ status: "verified", description: "add bag" }),
    fakeOutcome({ status: "verified", description: "apply credit" }),
  ]);
  assert.equal(g.blocked, false);
  assert.equal(g.verified_count, 2);
  assert.deepEqual(g.pending, []);
  assert.deepEqual(g.failed, []);
});

test("replyGateBlocked: any pending row → BLOCKED, pending named", () => {
  const g = replyGateBlocked([
    fakeOutcome({ status: "verified", description: "add bag" }),
    fakeOutcome({ status: "pending", description: "apply credit" }),
  ]);
  assert.equal(g.blocked, true);
  assert.deepEqual(g.pending, ["apply credit"]);
  assert.deepEqual(g.failed, []);
  assert.equal(g.verified_count, 1);
});

test("replyGateBlocked: any done row → BLOCKED (executor fired but DB verify hasn't confirmed)", () => {
  const g = replyGateBlocked([
    fakeOutcome({ status: "done", description: "apply credit" }),
  ]);
  assert.equal(g.blocked, true, "done means the handler fired, not that the DB predicate held; not ship-worthy");
  assert.deepEqual(g.pending, ["apply credit"]);
});

test("replyGateBlocked: any failed row → BLOCKED, failed named for the escalation", () => {
  const g = replyGateBlocked([
    fakeOutcome({ status: "verified", description: "add bag to next order" }),
    fakeOutcome({ status: "failed", description: "apply $15 credit" }),
  ]);
  assert.equal(g.blocked, true);
  assert.deepEqual(g.failed, ["apply $15 credit"]);
  assert.deepEqual(g.pending, []);
});

test("replyGateBlocked: mixed pending + failed + verified — all reasons surfaced", () => {
  const g = replyGateBlocked([
    fakeOutcome({ status: "verified", description: "add bag" }),
    fakeOutcome({ status: "pending", description: "apply credit" }),
    fakeOutcome({ status: "failed", description: "cancel next box" }),
  ]);
  assert.equal(g.blocked, true);
  assert.deepEqual(g.pending, ["apply credit"]);
  assert.deepEqual(g.failed, ["cancel next box"]);
  assert.equal(g.verified_count, 1);
});

// ── Judy ordering: honor decides BEFORE gate opens ───────────────────────

test("Judy ordering: honor step decides both items BEFORE the reply gate is checked (Phase-2 invariant)", async () => {
  // Two structured outcomes distilled from Judy's ask.
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "pending" }),
  ];
  const events: string[] = [];
  // Simulate the ordered pipeline: for each pending item, dispatch + verify; only then check the gate.
  for (const o of outcomes) {
    const decision = await decideOutcome(
      outcomeToActionParams(o),
      async () => { events.push(`dispatched:${o.kind}`); return { success: true }; },
      async () => { events.push(`verified:${o.kind}`); return true; },
    );
    // Mutate the outcome's status locally for the gate check (real code goes through markOutcome*).
    o.status = decision.verdict === "verified" ? "verified" : "failed";
  }
  const g = replyGateBlocked(outcomes);
  events.push(`gate:blocked=${g.blocked}`);
  // ORDERING: every dispatch + verify pair fires BEFORE the gate ever opens.
  assert.deepEqual(events, [
    "dispatched:add_bag_to_next_order", "verified:add_bag_to_next_order",
    "dispatched:apply_coupon", "verified:apply_coupon",
    "gate:blocked=false",
  ]);
  assert.equal(g.blocked, false, "the gate must open only once every item is verified");
});

test("Judy failure: apply_coupon dispatch fails → gate REMAINS BLOCKED, credit named for escalation, add_bag stays verified", async () => {
  const outcomes = [
    fakeOutcome({ id: "o1", kind: "add_bag_to_next_order", description: "add a second bag to next order", status: "pending" }),
    fakeOutcome({ id: "o2", kind: "apply_coupon", description: "apply $15 credit", status: "pending" }),
  ];
  const events: string[] = [];
  for (const o of outcomes) {
    const decision = await decideOutcome(
      outcomeToActionParams(o),
      async () => {
        events.push(`dispatched:${o.kind}`);
        if (o.kind === "apply_coupon") return { success: false, error: "coupon executor refused: no such code" };
        return { success: true };
      },
      async () => { events.push(`verified:${o.kind}`); return true; },
    );
    if (decision.verdict === "verified") {
      o.status = "verified";
    } else {
      o.status = "failed";
      o.failed_reason = (decision as { reason: string }).reason;
    }
  }
  const g = replyGateBlocked(outcomes);
  events.push(`gate:blocked=${g.blocked}`);
  // ORDERING preserved. Verify is skipped for the failed dispatch (learning from decideOutcome).
  assert.deepEqual(events, [
    "dispatched:add_bag_to_next_order", "verified:add_bag_to_next_order",
    "dispatched:apply_coupon", // NO "verified:apply_coupon" — dispatch failed, verify was skipped
    "gate:blocked=true",
  ]);
  assert.equal(g.blocked, true, "a failed action MUST leave the gate closed — no reply may ship");
  assert.deepEqual(g.failed, ["apply $15 credit"], "the failed item is named for the Phase-4 escalation");
  assert.equal(g.verified_count, 1, "the successfully-verified add_bag stays verified — partial progress is preserved");
});

// ── outcomeToActionParams ───────────────────────────────────────────────

test("outcomeToActionParams spreads target_ids into params under the row's kind", () => {
  const action = outcomeToActionParams(fakeOutcome({
    kind: "apply_coupon",
    target_ids: { contract_id: "gid://shopify/SubscriptionContract/1", code: "JUDY15" },
  }));
  assert.equal(action.type, "apply_coupon");
  assert.equal(action.contract_id, "gid://shopify/SubscriptionContract/1");
  assert.equal(action.code, "JUDY15");
});

test("outcomeToActionParams: empty target_ids → params carry only type", () => {
  const action = outcomeToActionParams(fakeOutcome({ kind: "cancel", target_ids: {} }));
  assert.equal(action.type, "cancel");
  assert.equal(Object.keys(action).length, 1);
});

// ── honorSummaryToLedgerOutcome ─────────────────────────────────────────

test("honorSummaryToLedgerOutcome: all verified → 'confirmed'", () => {
  const outcome = honorSummaryToLedgerOutcome({
    attempted: [],
    all_verified: true,
    failed_items: [],
    skipped_already_verified: 2,
    carried_forward_failed: [],
  });
  assert.equal(outcome, "confirmed");
});

test("honorSummaryToLedgerOutcome: any failed_items → 'drifted'", () => {
  const outcome = honorSummaryToLedgerOutcome({
    attempted: [],
    all_verified: false,
    failed_items: [{ outcome_id: "x", kind: "apply_coupon", description: "credit", final_status: "failed", failed_reason: "no code" }],
    skipped_already_verified: 0,
    carried_forward_failed: [],
  });
  assert.equal(outcome, "drifted");
});

test("honorSummaryToLedgerOutcome: any carried_forward_failed → 'drifted'", () => {
  const outcome = honorSummaryToLedgerOutcome({
    attempted: [],
    all_verified: false,
    failed_items: [],
    skipped_already_verified: 0,
    carried_forward_failed: [{ outcome_id: "x", kind: "cancel", description: "cancel next box", final_status: "failed" }],
  });
  assert.equal(outcome, "drifted");
});
