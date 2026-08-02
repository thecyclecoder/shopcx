/**
 * Unit tests — regression fixture for the ticket that prompted
 * june-restores-a-grandfathered-price-without-escalating (Phase 3 verification).
 *
 * The shape of the Vicki case (cvent@gci.net, 2026-07-31): a subscription whose
 * live line price is materially above the rate its own renewal history
 * demonstrates, where the demonstrated/established rate falls BELOW the 50%-MSRP
 * floor. Sol and June each diagnosed it correctly and each escalated because
 * both concluded the $24.95 rate "can no longer be offered" — reasoning from
 * the floor as absolute, which the CEO overruled on 2026-08-01. Phase 1 of the
 * spec wrote the ruling into the Subscription policy's INTERNAL half
 * (`pricing.historical_rate_beats_floor`); Phase 2 named
 * `restore_grandfathered_price` in June's leash and pinned the bound (NO
 * price in the payload; value derived by `deriveRestoreBase`; a raise
 * classified by `isRaiseAttempt` still escalates). This test fixture pins the
 * three asserts the spec calls out so a leash widening cannot silently
 * re-break the bound the widening rests on:
 *
 *   (a) June's verdict path can select the restore remedy — a RemedyPlan
 *       naming `restore_grandfathered_price` planned by `planRemedyExecution`
 *       returns `ok:true` with the action queued (the leash is broadened; the
 *       plan is not rejected upstream).
 *   (b) The executed value equals `deriveRestoreBase`'s output and NOT any
 *       number in the verdict — even when the agent supplies an arbitrary
 *       $99.00 base, the signal's computed $33.27 (Vicki's $24.95 realized ÷
 *       0.75 S&S) wins; that value is what reaches `subUpdateLineItemPrice`.
 *   (c) The same flow with an established rate ABOVE the live price escalates
 *       instead of executing — the signal path's `exceeds_established` guard
 *       refuses, and `isRaiseAttempt` returns true so the executor's raise
 *       escalation fires instead of the write.
 *
 * Run:
 *   npm run test:vicki-restore-below-floor
 *   (= tsx --test src/lib/subscription-overcharge.vicki-restore-below-floor.test.ts)
 *
 * Spec: docs/brain/specs/june-restores-a-grandfathered-price-without-escalating.md Phase 3.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveRestoreBase,
  isRaiseAttempt,
  type OverchargeSignal,
  type RestoreBaseRefuseReason,
} from "./subscription-overcharge";
import { planRemedyExecution } from "./cs-director";

const VICKI_CONTRACT = "gid://shopify/SubscriptionContract/vicki-77777";
const VARIANT = "vicki-variant-1";

/**
 * Vicki's numbers (rounded for the fixture but faithful to the spec's grounding).
 *   - MSRP $79.90 → 50%-MSRP realized floor = $39.95
 *   - Demonstrated realized ($24.95) is BELOW that floor — the entire reason
 *     the pre-ruling agents refused; the CEO ruling honours it anyway.
 *   - Restore base = $24.95 ÷ 0.75 (25% S&S) = $33.27 → 3327 cents.
 *   - Current charged/unit ($59.96) is the bad renewal Vicki wrote in about.
 */
const DEMONSTRATED_REALIZED_CENTS = 2495; // $24.95 — Vicki's four-consecutive-renewal rate
const RESTORE_BASE_CENTS = 3327; // $33.27 — deriveRestoreBase's computed output
const LIVE_CHARGED_CENTS = 5996; // $59.96 — the renewal that spiked

function makeVickiSignal(): OverchargeSignal {
  return {
    detected: true,
    subscription_id: "vicki-sub-1",
    shopify_contract_id: VICKI_CONTRACT,
    is_internal: false,
    order_id: "vicki-order-1",
    shopify_order_id: "88888",
    order_number: "SC220731",
    financial_status: "paid",
    charged: LIVE_CHARGED_CENTS,
    expected: DEMONSTRATED_REALIZED_CENTS,
    delta: LIVE_CHARGED_CENTS - DEMONSTRATED_REALIZED_CENTS,
    dropped_base: true,
    lines: [
      {
        variant_id: VARIANT,
        title: "Superfood Chocolate",
        quantity: 1,
        charged_per_unit: LIVE_CHARGED_CENTS,
        expected_per_unit: DEMONSTRATED_REALIZED_CENTS,
        restore_base_cents: RESTORE_BASE_CENTS,
      },
    ],
    reason: "4 consecutive renewals at $24.95 → live line $59.96; demonstrated < 50%-MSRP floor",
  };
}

// ── (a) JUNE'S VERDICT PATH CAN SELECT THE RESTORE REMEDY ─────────────

test("(a) planRemedyExecution accepts a restore_grandfathered_price remedy — the leash is broadened at the planner", () => {
  // Phase 2 named `restore_grandfathered_price` in the SKILL.md leash. The
  // planner is action-type agnostic (it validates the shape, not the name),
  // so what this test really pins is: a RemedyPlan carrying June's named
  // remedy plans cleanly (`ok:true`, one action queued) instead of being
  // rejected upstream by the remedy-shape rails.
  const result = planRemedyExecution({
    action_type: "restore_grandfathered_price",
    payload: { contract_id: VICKI_CONTRACT },
    summary: "restore Vicki to her demonstrated $24.95 rate",
    customer_message: "Sorted — restoring your subscription to your usual rate on the next renewal.",
    confidence: 0.9,
  });

  assert.equal(result.ok, true, "June's remedy shape must plan cleanly");
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.plan.actions.length, 1);
  assert.equal(
    result.plan.actions[0].actionType,
    "restore_grandfathered_price",
    "the planner preserves the literal remedy name so the executor / audit trail see it",
  );
  assert.equal(
    (result.plan.actions[0].actionParams as { contract_id?: string }).contract_id,
    VICKI_CONTRACT,
    "the payload names the subscription, not a price — the bound Phase 2 pinned",
  );
  // The bound the leash rests on — no price in the payload. This is the
  // whole reason the remedy is safe to delegate; a caller that starts
  // passing `base_price_cents` in the payload has broken the bound.
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.plan.actions[0].actionParams, "base_price_cents"),
    false,
    "no price in the payload — deriveRestoreBase is the sanctioned source",
  );
});

// ── (b) EXECUTED VALUE = deriveRestoreBase'S OUTPUT, NOT ANY NUMBER IN THE VERDICT ─

test("(b) below-floor demonstrated rate: the signal-computed base wins over an arbitrary agent-supplied number", async () => {
  // The Vicki case exactly: demonstrated realized $24.95 is BELOW the 50%-MSRP
  // floor ($39.95). Pre-2026-08-01 the agents refused to restore for that
  // reason. With the CEO ruling written into the policy and the leash widened,
  // deriveRestoreBase's output (from renewal history, floor-clamped by the
  // detector, or explicitly-below-floor when demonstrated) is what reaches
  // `subUpdateLineItemPrice`. Even a wildly-wrong agent-supplied base
  // ($99.00) is IGNORED — the signal is the sanctioned source.
  const ARBITRARY_AGENT_NUMBER_CENTS = 9900; // $99.00 — a made-up number the agent should not be trusted with
  const projectCalls: Array<number | null> = [];

  const decision = await deriveRestoreBase({
    signal: makeVickiSignal(),
    contractId: VICKI_CONTRACT,
    variantId: VARIANT,
    agentBaseCents: ARBITRARY_AGENT_NUMBER_CENTS,
    project: async (proposedBaseCents) => {
      projectCalls.push(proposedBaseCents);
      // Current realized (proposedBaseCents=null) is the bad live rate; the
      // signal base's projection returns to Vicki's demonstrated $24.95.
      return proposedBaseCents == null ? LIVE_CHARGED_CENTS : DEMONSTRATED_REALIZED_CENTS;
    },
  });

  assert.equal(decision.ok, true, "a signal-path restore below the floor must NOT refuse");
  if (!decision.ok) throw new Error("unreachable");
  assert.equal(decision.source, "signal", "the signal is the sanctioned source when it names the target variant");
  assert.equal(
    decision.base,
    RESTORE_BASE_CENTS,
    "the executed value is the signal's computed $33.27, not the agent's $99.00 — the bound the leash rests on",
  );
  assert.equal(decision.signalRestoreBaseCents, RESTORE_BASE_CENTS);
  assert.equal(decision.agentBaseCents, ARBITRARY_AGENT_NUMBER_CENTS);
  assert.equal(
    decision.projectedRealizedPerUnitCents,
    DEMONSTRATED_REALIZED_CENTS,
    "the projected realized returns to Vicki's demonstrated $24.95 — a below-floor rate the CEO ruling permits",
  );
  assert.match(
    decision.note,
    /agent-proposed \$99\.00.*signal-computed \$33\.27/,
    "the audit note shows both numbers so the arithmetic drift is visible in the ticket thread",
  );
  assert.deepEqual(
    projectCalls,
    [null, RESTORE_BASE_CENTS],
    "the projector is queried for the current realized (null) and for the signal-base's projection",
  );
});

// ── (c) INVERTED FLOW: ESTABLISHED ABOVE LIVE → ESCALATES, DOES NOT EXECUTE ─

test("(c) established rate ABOVE the live price: deriveRestoreBase refuses via exceeds_established, isRaiseAttempt says escalate", async () => {
  // Same shape as Vicki but INVERTED — the signal's expected/restore base
  // would raise the customer's realized above the current live rate. The
  // signal-path guard (`decision.projected > expected + 1`) refuses; the
  // `isRaiseAttempt` classifier says this is a raise class the executor
  // escalates rather than writes. This is the bound Phase 2 pinned: lowering
  // toward a demonstrated rate is in-leash, ANYTHING that would raise a
  // customer's price is not, and no amount of agent reasoning may cross that
  // line.
  const invertedSignal: OverchargeSignal = {
    ...makeVickiSignal(),
    // Established rate now ABOVE the live rate — the arithmetic sign of an
    // overcharge, but the projection will exceed it (an internal quantity
    // break stacked on top of the base, per the executor's inline comment).
    lines: [
      {
        ...makeVickiSignal().lines[0],
        expected_per_unit: 3500, // $35 established
        restore_base_cents: 4667, // $35 / 0.75 = $46.67
        charged_per_unit: 2495, // $24.95 currently charged (below established)
      },
    ],
  };

  const decision = await deriveRestoreBase({
    signal: invertedSignal,
    contractId: VICKI_CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 4667,
    // The signal base's projection COMES OUT ABOVE the established (a break
    // stacked oddly) — the guard refuses so the write cannot raise.
    project: async (proposedBaseCents) => (proposedBaseCents == null ? 2495 : 3800),
  });

  assert.equal(decision.ok, false, "the guard must refuse — the write would raise the realized above established");
  if (decision.ok) throw new Error("unreachable");
  assert.equal(
    decision.refuseReason,
    "exceeds_established",
    "the signal-path exceeds-established guard fires — a raise must escalate, not execute",
  );
  assert.equal(
    isRaiseAttempt(decision.refuseReason as RestoreBaseRefuseReason),
    true,
    "isRaiseAttempt classifies this as the escalation-worthy raise class the executor pages the CEO on",
  );
});

test("(c-bis) no-signal raise: agent-supplied base above current realized refuses via raise_no_signal — also an escalation class", async () => {
  // The other raise-escalation class Phase 2 must still refuse: no
  // overcharge signal, and the agent proposes a base whose realized would
  // exceed the customer's current realized. Same escalation outcome as
  // (c) via a different `refuseReason` — `isRaiseAttempt` recognizes both.
  const decision = await deriveRestoreBase({
    signal: null,
    contractId: VICKI_CONTRACT,
    variantId: VARIANT,
    agentBaseCents: 6000,
    // Sub currently realizes $24.95 (Vicki's demonstrated); the agent's
    // proposed base yields $45.00 — a $20 raise a wrong-number agent could
    // otherwise slip through.
    project: async (proposedBaseCents) => (proposedBaseCents == null ? DEMONSTRATED_REALIZED_CENTS : 4500),
  });

  assert.equal(decision.ok, false, "a no-signal RAISE must be refused");
  if (decision.ok) throw new Error("unreachable");
  assert.equal(decision.refuseReason, "raise_no_signal");
  assert.equal(
    isRaiseAttempt(decision.refuseReason as RestoreBaseRefuseReason),
    true,
    "isRaiseAttempt recognizes raise_no_signal as an escalation-worthy raise too",
  );
});
