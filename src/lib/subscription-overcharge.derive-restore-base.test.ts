/**
 * Unit tests for `deriveRestoreBase` — the sanctioned-source rule for a
 * `update_line_item_price` write. The agent may TRIGGER a price correction,
 * but may not INVENT the number: when the overcharge signal names the
 * target variant, its `restore_base_cents` wins; when no signal exists we
 * refuse a RAISE and clamp with the shared `>= $1 AND >= 2%` materiality
 * floor. Extracted from the action-executor handler so the decision can be
 * pinned without a live DB — the projector is passed as a fixture.
 *
 * Spec: docs/brain/specs/a-price-correction-must-use-the-computed-rate-not-an-agents-arithmetic
 * Phase 3 — the three scenarios the spec's Verification enumerates:
 *   (a) an agent figure that disagrees with the signal is overridden by the signal
 *   (b) a raise with no signal is refused
 *   (c) a lower price with no signal is allowed
 *
 * Run:
 *   npm run test:derive-restore-base
 *   (= tsx --test src/lib/subscription-overcharge.derive-restore-base.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { deriveRestoreBase, type OverchargeSignal } from "./subscription-overcharge";

const CONTRACT = "gid://shopify/SubscriptionContract/1";
const VARIANT = "44444";

function makeSignal(line: {
  variantId?: string;
  chargedPerUnit: number;
  expectedPerUnit: number;
  restoreBaseCents: number;
}): OverchargeSignal {
  return {
    detected: true,
    subscription_id: "sub-1",
    shopify_contract_id: CONTRACT,
    is_internal: false,
    order_id: "order-1",
    shopify_order_id: "5555",
    order_number: "R1000",
    financial_status: "paid",
    charged: line.chargedPerUnit,
    expected: line.expectedPerUnit,
    delta: line.chargedPerUnit - line.expectedPerUnit,
    dropped_base: false,
    lines: [
      {
        variant_id: line.variantId ?? VARIANT,
        title: "Superfood Tabs",
        quantity: 1,
        charged_per_unit: line.chargedPerUnit,
        expected_per_unit: line.expectedPerUnit,
        restore_base_cents: line.restoreBaseCents,
      },
    ],
    reason: "test signal",
  };
}

// ── (a) SIGNAL PATH: agent's number is overridden by the signal ───────

test("(a) signal-vs-agent divergence: signal's restore_base_cents wins, agent number is only logged", async () => {
  // r.aycock scenario: agent proposed $54.78 (the order total). Signal
  // computed the correct restore base for a $44.95 per-unit at 25% S&S =
  // $59.93. The signal wins.
  const signal = makeSignal({
    chargedPerUnit: 5478,
    expectedPerUnit: 4495,
    restoreBaseCents: 5993,
  });
  const projectCalls: Array<number | null> = [];
  const projected = 4495; // after the write, realized returns to expected
  const decision = await deriveRestoreBase({
    signal,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 5478,
    project: async (proposedBaseCents) => {
      projectCalls.push(proposedBaseCents);
      return proposedBaseCents == null ? 5478 : projected;
    },
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("unreachable");
  assert.equal(decision.source, "signal", "the signal is the sanctioned source");
  assert.equal(decision.base, 5993, "writes the signal-computed restore base, not the agent's $54.78");
  assert.equal(decision.signalRestoreBaseCents, 5993);
  assert.equal(decision.agentBaseCents, 5478);
  assert.match(
    decision.note,
    /agent-proposed \$54\.78.*signal-computed \$59\.93/,
    "the note shows both numbers so the divergence is visible in the ticket thread",
  );
  assert.deepEqual(
    projectCalls,
    [null, 5993],
    "the projector is asked for the current realized (null) and the signal-base's projection",
  );
});

test("signal path with a small divergence (<= $1) records no override note", async () => {
  const signal = makeSignal({
    chargedPerUnit: 5000,
    expectedPerUnit: 4495,
    restoreBaseCents: 5993,
  });
  const decision = await deriveRestoreBase({
    signal,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 5993, // matches signal exactly
    project: async () => 4495,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("unreachable");
  assert.equal(decision.base, 5993);
  assert.equal(decision.note, "", "no divergence → no override note");
});

test("signal path refuses when the projected realized would exceed established (e.g. internal quantity break gone wrong)", async () => {
  const signal = makeSignal({
    chargedPerUnit: 5000,
    expectedPerUnit: 4495,
    restoreBaseCents: 5993,
  });
  // Suppose the sub has a break that makes the projected realized COME OUT
  // higher than expected — the guard refuses the write.
  const decision = await deriveRestoreBase({
    signal,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 5993,
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 5000 : 4700),
  });
  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error("unreachable");
  assert.equal(decision.refuseReason, "exceeds_established");
  assert.equal(decision.projectedRealizedPerUnitCents, 4700);
});

// ── (b) NO SIGNAL: refuse a RAISE ─────────────────────────────────────

test("(b) no signal + agent wants to RAISE realized price → refused with the raise_no_signal reason", async () => {
  const decision = await deriveRestoreBase({
    signal: null,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 6000,
    // Sub currently realizes $44.95; the agent's proposed base yields $54.78.
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 4495 : 5478),
  });
  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error("unreachable");
  assert.equal(decision.refuseReason, "raise_no_signal");
  assert.equal(decision.previousRealizedPerUnitCents, 4495);
  assert.equal(decision.projectedRealizedPerUnitCents, 5478);
  assert.match(decision.error, /Refusing to raise realized price/);
  assert.match(decision.error, /\$44\.95 to \$54\.78/);
});

test("no signal + tiny raise below materiality → refused as immaterial (not as a raise)", async () => {
  const decision = await deriveRestoreBase({
    signal: null,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 4496,
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 4495 : 4496),
  });
  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error("unreachable");
  assert.equal(decision.refuseReason, "immaterial");
});

// ── (c) NO SIGNAL: material LOWER is allowed ──────────────────────────

test("(c) no signal + material lower → allowed (goodwill discount is a real use)", async () => {
  const decision = await deriveRestoreBase({
    signal: null,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 3500,
    // Sub currently realizes $44.95; the agent lowers it to $35.00.
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 4495 : 3500),
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) throw new Error("unreachable");
  assert.equal(decision.source, "agent", "no signal → the agent number is written (bounded by the guards above)");
  assert.equal(decision.base, 3500);
  assert.equal(decision.note, "");
  assert.equal(decision.previousRealizedPerUnitCents, 4495);
  assert.equal(decision.projectedRealizedPerUnitCents, 3500);
});

test("no signal + tiny lower below materiality → refused as immaterial (catalog rounding drift, not a real correction)", async () => {
  // 2026-08-02 failure mode: an agent proposes a $0.01 change and the
  // handler mints a wrong-narrative "we overcharged you" event on an
  // untouched subscription. The materiality floor refuses it.
  const decision = await deriveRestoreBase({
    signal: null,
    contractId: CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 4494,
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 4495 : 4494),
  });
  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error("unreachable");
  assert.equal(decision.refuseReason, "immaterial");
  assert.match(decision.error, /materiality floor/);
});
