/**
 * escalation-retirement-sweep — Phase 2 verification for
 * [[../../docs/brain/specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]].
 * Pins the pure `decideRetirement` helper: retire ONLY on positive proof of healing, unreadable
 * state leaves the card alone (fail-closed), non_retirable never retires.
 *
 *   npx tsx --test src/lib/escalation-retirement-sweep.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideRetirement } from "./escalation-retirement-sweep";

test("non_retirable — never retires, regardless of state", () => {
  const d = decideRetirement(
    { kind: "non_retirable", reason: "founder yes/no on storefront campaign" },
    {},
  );
  assert.equal(d.retire, false);
  if (!d.retire) assert.match(d.reason, /non_retirable/);
});

test("ticket_terminal — retires when status='closed'; leaves anything else alone", () => {
  const closed = decideRetirement(
    { kind: "ticket_terminal", ticket_id: "2c49bc7e" },
    { ticketStatus: "closed" },
  );
  assert.equal(closed.retire, true);
  if (closed.retire) {
    assert.match(closed.evidenceReason, /2c49bc7e/);
    assert.equal((closed.evidence as { kind: string }).kind, "ticket_terminal");
  }
  const open = decideRetirement(
    { kind: "ticket_terminal", ticket_id: "t-1" },
    { ticketStatus: "open" },
  );
  assert.equal(open.retire, false);
});

test("ticket_terminal — unreadable state → fail-closed (never retire on missing data)", () => {
  const d = decideRetirement({ kind: "ticket_terminal", ticket_id: "t-1" }, {});
  assert.equal(d.retire, false);
  if (!d.retire) assert.match(d.reason, /unreadable/);
});

test("job_terminal — retires when job left needs_attention / active statuses; leaves live", () => {
  const done = decideRetirement(
    { kind: "job_terminal", agent_job_id: "job-abc" },
    { jobStatus: "completed" },
  );
  assert.equal(done.retire, true);

  const parked = decideRetirement(
    { kind: "job_terminal", agent_job_id: "job-abc" },
    { jobStatus: "needs_attention" },
  );
  assert.equal(parked.retire, false, "needs_attention counts as live — do NOT retire");

  const claimed = decideRetirement(
    { kind: "job_terminal", agent_job_id: "job-abc" },
    { jobStatus: "claimed" },
  );
  assert.equal(claimed.retire, false, "an active build is live — do NOT retire");
});

test("action_satisfied subscription_exists — retires when customer has an active subscription", () => {
  const has = decideRetirement(
    { kind: "action_satisfied", action: "subscription_exists", customer_id: "cust-1" },
    { activeSubscriptionId: "sub-99" },
  );
  assert.equal(has.retire, true);
  if (has.retire) assert.match(has.evidenceReason, /sub-99|active/);

  const missing = decideRetirement(
    { kind: "action_satisfied", action: "subscription_exists", customer_id: "cust-1" },
    { activeSubscriptionId: null },
  );
  assert.equal(missing.retire, false);

  const unreadable = decideRetirement(
    { kind: "action_satisfied", action: "subscription_exists", customer_id: "cust-1" },
    {},
  );
  assert.equal(unreadable.retire, false, "unreadable → fail-closed");
});

test("action_satisfied order_exists — retires when customer has an order", () => {
  const has = decideRetirement(
    { kind: "action_satisfied", action: "order_exists", customer_id: "cust-1" },
    { orderId: "ord-42" },
  );
  assert.equal(has.retire, true);
  const missing = decideRetirement(
    { kind: "action_satisfied", action: "order_exists", customer_id: "cust-1" },
    { orderId: null },
  );
  assert.equal(missing.retire, false);
});
