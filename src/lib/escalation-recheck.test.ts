/**
 * escalation-recheck — the typed self-heal descriptor an escalation carries on
 * `metadata.retire_when`. Phase 1 verification for
 * [[../../docs/brain/specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]].
 * Pins the fail-closed contract at the boundary: absence + malformed input → non-retirable, every
 * well-formed shape validates + round-trips, and the four shapes documented in the spec exist.
 *
 *   npx tsx --test src/lib/escalation-recheck.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isRetirable,
  readEscalationRecheckDescriptor,
  RETIRE_WHEN_METADATA_KEY,
  validateEscalationRecheckDescriptor,
  type EscalationRecheckDescriptor,
} from "./escalation-recheck";

test("RETIRE_WHEN_METADATA_KEY is the snake_case jsonb key name the raise paths + sweep both use", () => {
  assert.equal(RETIRE_WHEN_METADATA_KEY, "retire_when");
});

test("readEscalationRecheckDescriptor — absent descriptor returns null (fail-closed default)", () => {
  assert.equal(readEscalationRecheckDescriptor(null), null);
  assert.equal(readEscalationRecheckDescriptor(undefined), null);
  assert.equal(readEscalationRecheckDescriptor({}), null);
  assert.equal(readEscalationRecheckDescriptor({ other: "field" }), null);
  assert.equal(readEscalationRecheckDescriptor({ [RETIRE_WHEN_METADATA_KEY]: null }), null);
});

test("readEscalationRecheckDescriptor — malformed descriptor returns null (fail-closed default)", () => {
  assert.equal(
    readEscalationRecheckDescriptor({ [RETIRE_WHEN_METADATA_KEY]: "not-an-object" }),
    null,
  );
  assert.equal(
    readEscalationRecheckDescriptor({ [RETIRE_WHEN_METADATA_KEY]: { kind: "unknown_kind" } }),
    null,
  );
  assert.equal(
    readEscalationRecheckDescriptor({ [RETIRE_WHEN_METADATA_KEY]: { kind: "ticket_terminal" } }),
    null,
    "missing ticket_id must reject",
  );
  assert.equal(
    readEscalationRecheckDescriptor({
      [RETIRE_WHEN_METADATA_KEY]: { kind: "ticket_terminal", ticket_id: "" },
    }),
    null,
    "empty ticket_id must reject (non-empty string)",
  );
});

test("isRetirable — null and non_retirable both return false; everything else returns true", () => {
  assert.equal(isRetirable(null), false, "absence → non-retirable");
  assert.equal(
    isRetirable({ kind: "non_retirable", reason: "founder yes/no on storefront campaign" }),
    false,
    "explicit non-retirable → non-retirable",
  );
  assert.equal(isRetirable({ kind: "ticket_terminal", ticket_id: "t-1" }), true);
  assert.equal(isRetirable({ kind: "job_terminal", agent_job_id: "j-1" }), true);
  assert.equal(
    isRetirable({ kind: "action_satisfied", action: "subscription_exists", customer_id: "c-1" }),
    true,
  );
});

test("validateEscalationRecheckDescriptor — round-trips every well-formed shape", () => {
  const shapes: EscalationRecheckDescriptor[] = [
    { kind: "ticket_terminal", ticket_id: "2c49bc7e" },
    { kind: "job_terminal", agent_job_id: "abcd-1234" },
    { kind: "action_satisfied", action: "subscription_exists", customer_id: "cust-1" },
    { kind: "action_satisfied", action: "order_exists", customer_id: "cust-2" },
    { kind: "non_retirable", reason: "founder yes/no" },
  ];
  for (const s of shapes) {
    const v = validateEscalationRecheckDescriptor(s);
    assert.ok(v.valid, `shape ${s.kind} must validate`);
    if (v.valid) assert.deepEqual(v.value, s);
  }
});

test("validateEscalationRecheckDescriptor — action_satisfied only accepts the enumerated action set", () => {
  const bad = validateEscalationRecheckDescriptor({
    kind: "action_satisfied",
    action: "email_delivered",
    customer_id: "c-1",
  });
  assert.ok(!bad.valid, "unknown action must reject — the enumerated set is closed");
  if (!bad.valid) assert.match(bad.reason, /subscription_exists.*order_exists/);
});

test("readEscalationRecheckDescriptor — reads a well-formed descriptor from realistic metadata jsonb", () => {
  // The exact shape assisted-purchase-failure-card.ts writes for the 2026-08-14 ground-truth case.
  const meta = {
    routed_to_function: "ceo",
    raised_by_function: "cs",
    escalation_kind: "assisted_purchase_failure",
    ticket_id: "2c49bc7e",
    customer_id: "cust-susan-1",
    action_type: "create_subscription",
    [RETIRE_WHEN_METADATA_KEY]: {
      kind: "action_satisfied",
      action: "subscription_exists",
      customer_id: "cust-susan-1",
    },
  };
  const d = readEscalationRecheckDescriptor(meta);
  assert.ok(d, "must extract the descriptor from realistic metadata");
  assert.equal(d?.kind, "action_satisfied");
  assert.equal(isRetirable(d), true, "action_satisfied is retirable — Phase-2 sweep will check the subscription");
});
