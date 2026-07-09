/**
 * Phase 3 verification test for
 * [[../../docs/brain/specs/sol-reads-moved-as-address-update-and-replacement-offer-not-cancel-deadend]]
 *
 * Verification bullets (spec § Phase 3):
 *   - A move signal with an active subscription never produces a cancel-only / no-redirect
 *     terminal reply.
 *   - A customer who insists on cancelling after the offer is handed the self-service cancel
 *     journey.
 *   - The already-shipped order is acknowledged truthfully without ending the save path.
 *
 * Pure-function tests seeded with each shape. Run:
 *   npx tsx --test src/lib/sol-move-dead-end-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assessSolMoveDeadEndRisk } from "./sol-move-dead-end-guard";

test("move + active sub + we'll-cancel dead-end → BLOCKED (move_dead_ended_as_cancel)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved, wants address update",
    contextSummary:
      "Customer just moved to a new address; active internal subscription on record. In-policy: move → address-update save.",
    firstReply:
      "Sorry, since your order already shipped, we'll cancel your subscription. Nothing more we can do.",
    hasActiveSubscription: true,
  });
  assert.equal(res.ok, false, "must block a cancel dead-end on a move with active sub");
  if (res.ok === false) {
    assert.equal(res.kind, "move_dead_ended_as_cancel");
    assert.match(res.matched_phrase, /cancel/i);
  }
});

test("move + active sub + 'already shipped can't redirect' dead-end with NO alternative → BLOCKED (no_redirect_without_alternative)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved",
    contextSummary: "Customer has moved; last order already shipped. Active subscription on record.",
    firstReply:
      "That order already shipped and we can't redirect it. Sorry about that.",
    hasActiveSubscription: true,
  });
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.kind, "move_terminal_no_redirect_without_alternative");
    assert.match(res.matched_phrase, /already shipped/i);
  }
});

test("move + active sub + I've-cancelled dead-end → BLOCKED (move_dead_ended_as_cancel)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer relocating",
    contextSummary: "Customer relocated to a new state; active subscription still charging.",
    firstReply:
      "I've gone ahead and cancelled your subscription. Nothing we can do about the shipment that already went out.",
    hasActiveSubscription: true,
  });
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.kind, "move_dead_ended_as_cancel");
    assert.match(res.matched_phrase, /cancel/i);
  }
});

test("move + active sub + 'already shipped can't redirect' + address-update alternative → PASSES (acknowledged + save path)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved, wants address updated",
    contextSummary: "Customer moved; last order already shipped. Active subscription.",
    firstReply:
      "That order already shipped and we can't redirect it, but I can update your shipping address on your subscription so all future shipments go to your new place. Tap the link below to confirm your new address.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "shipping-address" },
  });
  assert.equal(res.ok, true, "an ack paired with an address-update save path is not a dead-end");
});

test("move + active sub + 'already shipped' + replacement alternative → PASSES", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved, high-LTV, recent shipped order",
    contextSummary: "High-LTV moved customer; recent order shipped to old address. Active subscription.",
    firstReply:
      "That last order already shipped and I can't redirect it, but I can send you a free replacement to your new address. Want me to send it?",
    hasActiveSubscription: true,
  });
  assert.equal(res.ok, true, "acknowledgment + $0 replacement offer is a save path");
});

test("move + no active subscription → PASSES (there's nothing to save)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved, subscription already cancelled",
    contextSummary: "Customer moved; subscription was already cancelled last month. Nothing active.",
    firstReply:
      "Thanks for letting me know. That order already shipped and we can't redirect it — sorry for the trouble.",
    hasActiveSubscription: false,
  });
  assert.equal(res.ok, true, "no active sub → no move-save invariant to enforce");
});

test("no move signal + cancel reply → PASSES (guard scope is move-triggered replies only)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer wants to cancel",
    contextSummary: "Customer requested cancellation directly. No move mentioned.",
    firstReply: "We'll cancel your subscription now.",
    hasActiveSubscription: true,
  });
  // Cancel-reply on a non-move ticket isn't THIS guard's job — the sonnet_orchestrator /
  // cancel journey routing handles that path. Guard falls back to ok:true, other guards apply.
  assert.equal(res.ok, true);
});

test("move + active sub + reply that offers alternative WITHOUT dead-end phrase → PASSES", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved",
    contextSummary: "Customer moved; active subscription.",
    firstReply: "No problem — tap below and confirm your new address. All future shipments will go there.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "shipping-address" },
  });
  assert.equal(res.ok, true);
});

test("cancel-after-offer honest path: Direction slug='cancel-subscription' + hand-off reply → PASSES", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer insists on cancel after move offer",
    contextSummary:
      "Customer moved, was offered address update + replacement, insists on cancel. Handing self-service cancel journey.",
    firstReply:
      "Got it — you can cancel your subscription yourself in a couple of taps. Here's the link.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "cancel-subscription" },
  });
  assert.equal(res.ok, true, "self-service cancel handoff is the honest path");
});

test("cancel-after-offer FAIL: Direction slug='cancel-subscription' but Sol cancels FOR the customer → BLOCKED (cancel_after_offer_without_self_service_handoff)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer insists on cancel after move offer",
    contextSummary: "Customer moved; insists on cancel after offer. Direction hands cancel journey.",
    firstReply:
      "Understood — I've cancelled your subscription. All done.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "cancel-subscription" },
  });
  assert.equal(res.ok, false);
  if (res.ok === false) {
    assert.equal(res.kind, "cancel_after_offer_without_self_service_handoff");
    assert.match(res.matched_phrase, /cancel/i);
  }
});

test("cancel-after-offer FAIL 2: 'your subscription is cancelled' with cancel-subscription slug → BLOCKED", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer insists on cancel",
    contextSummary: "Cancel path.",
    firstReply: "Done — your subscription has been cancelled.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "cancel-subscription" },
  });
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.kind, "cancel_after_offer_without_self_service_handoff");
});

test("empty reply → PASSES (no reply, nothing to gate; other guards handle empty replies)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved",
    contextSummary: "Customer moved; active sub.",
    firstReply: "",
    hasActiveSubscription: true,
  });
  assert.equal(res.ok, true);
});

test("various move signals arm the guard: 'new address', 'changed my address', 'relocating'", () => {
  for (const summary of [
    "Customer's new address is 1 Main St.",
    "Customer changed their shipping address.",
    "Customer is relocating to another state.",
  ]) {
    const res = assessSolMoveDeadEndRisk({
      intent: "address change",
      contextSummary: summary,
      firstReply: "We'll cancel your subscription.",
      hasActiveSubscription: true,
    });
    assert.equal(res.ok, false, `expected block for summary: ${summary}`);
  }
});

test("move-triggered reply uses launch_journey_slug='shipping-address' + acknowledgment → PASSES (Phase 1 wedge is honored)", () => {
  const res = assessSolMoveDeadEndRisk({
    intent: "customer moved to a new city",
    contextSummary: "Move signal; active subscription; Direction hands shipping-address journey.",
    firstReply:
      "No problem — the last order already shipped so we can't redirect that one, but you can confirm your new address below and every future shipment will go there.",
    hasActiveSubscription: true,
    plan: { launch_journey_slug: "shipping-address" },
  });
  assert.equal(res.ok, true);
});
