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

// ── Ground-truth regression: the exact 2026-08-14 pair the spec cites ─────────────────────────
// Cards a5376176 + 6c8ef178 (`assisted_purchase_failure`, action_type=`create_subscription`,
// ticket `2c49bc7e`) sat in the founder's inbox for 67 hours after the underlying condition
// healed — the customer's subscription was in fact created hours later, but no sweep re-asked
// the question. This test pins the shape the assisted-purchase-failure-card builder writes and
// exercises the sweep's decision helper against the ground-truth state transition (no
// subscription → subscription exists), the exact case Phase 2 exists to catch.
test("2026-08-14 Susan Bellamy: assisted-purchase-failure card retires when subscription exists", () => {
  // The retire_when descriptor buildAssistedPurchaseFailureCard writes for create_subscription.
  const descriptorFromGroundTruth = {
    kind: "action_satisfied",
    action: "subscription_exists",
    customer_id: "cust-susan-1",
  } as const;

  // T+0: card just minted, no active subscription — sweep must LEAVE the card alone.
  const atMint = decideRetirement(descriptorFromGroundTruth, { activeSubscriptionId: null });
  assert.equal(atMint.retire, false, "no subscription yet → card must stay in the inbox");

  // T+hours: system linked accounts + changed cadence + corrected billing → subscription NOW
  // exists. The sweep must retire the card AND name the specific subscription in the evidence
  // (not a bare clear — the founder must be able to audit what left and why).
  const afterHeal = decideRetirement(descriptorFromGroundTruth, { activeSubscriptionId: "sub-live-1" });
  assert.equal(afterHeal.retire, true, "customer now has active subscription → the card's condition healed");
  if (afterHeal.retire) {
    assert.match(
      afterHeal.evidenceReason,
      /sub-live-1|active subscription/,
      "evidence must name the actual subscription that healed the condition, not a generic phrase",
    );
    const ev = afterHeal.evidence as { kind: string; action: string; subscription_id: string; customer_id: string };
    assert.equal(ev.kind, "action_satisfied");
    assert.equal(ev.action, "subscription_exists");
    assert.equal(ev.subscription_id, "sub-live-1");
    assert.equal(ev.customer_id, "cust-susan-1");
  }
});

test("2026-08-14 sibling: a card WITHOUT a retire_when descriptor is left in place forever", () => {
  // The spec's fail-closed contract: "an un-migrated or unfamiliar raiser can never have its
  // card auto-cleared." A hypothetical pre-Phase-1 assisted-purchase-failure card carries the
  // same customer + subscription state, but no descriptor. The sweep must never touch it.
  //
  // decideRetirement never sees a `null` descriptor — that gate lives at the sweep's outer loop
  // via `isRetirable(readEscalationRecheckDescriptor(...))`. Re-assert both helpers here so a
  // future refactor cannot silently drop the fail-closed rule.
  const { isRetirable, readEscalationRecheckDescriptor } = require("./escalation-recheck") as {
    isRetirable: (d: unknown) => boolean;
    readEscalationRecheckDescriptor: (m: unknown) => unknown;
  };
  const preP1Metadata = {
    routed_to_function: "ceo",
    raised_by_function: "cs",
    escalation_kind: "assisted_purchase_failure",
    ticket_id: "2c49bc7e",
    customer_id: "cust-susan-1",
    action_type: "create_subscription",
    // NOTE: no `retire_when` — pre-Phase-1 card shape.
  };
  const d = readEscalationRecheckDescriptor(preP1Metadata);
  assert.equal(d, null, "absent descriptor → null (fail-closed default)");
  assert.equal(isRetirable(d), false, "sweep must skip a card with no descriptor");
});

test("standing-pass ceiling — sweep will not retire more than the per-pass cap in one call", () => {
  // Import here so the constant lives in module scope alongside the helper it caps.
  const { RETIREMENT_SWEEP_CAP_PER_PASS } = require("./escalation-retirement-sweep") as {
    RETIREMENT_SWEEP_CAP_PER_PASS: number;
  };
  assert.equal(
    RETIREMENT_SWEEP_CAP_PER_PASS,
    50,
    "the per-pass ceiling is the founder-visible signal that a burst is happening; keep it small (50)",
  );
});
