/**
 * Unit tests for the claim↔action binding guard (Phase 0). Pins the two
 * failure modes the guard must get right: it MUST catch first-person completed
 * effect claims (the "Category C" false promise), and it MUST NOT trip on
 * offers, questions, future intent, the customer's own actions, or generic
 * verbs on unrelated objects.
 *
 * Pure helper — no I/O. Run:
 *   npx tsx --test src/lib/claim-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { unbackedEffectClaim } from "./claim-guard";

const NONE = new Set<string>();

// MUST block (completed, first-person / passive, no backing action)
const BLOCK: Array<[string, string]> = [
  ["I've refunded you $45 back to your card.", "refund"],
  ["I've issued you a refund of $24.02.", "refund"],
  ["Your refund has been processed.", "refund"],
  ["I've gone ahead and cancelled your subscription.", "cancel"],
  ["Your subscription has been cancelled.", "cancel"],
  ["I've paused your subscription for you.", "pause"],
  ["I've applied a $15 coupon to your account.", "coupon"],
  ["I've created a return for you — the label is on its way.", "return"],
  ["I've placed a replacement order.", "order"],
  ["I've swapped your flavor to Hazelnut.", "swap"],
  ["I've changed your next delivery date to July 15.", "date"],
  ["I've updated your shipping address.", "address"],
];

// MUST NOT block (offer / question / future / customer's action / unrelated)
const ALLOW: string[] = [
  "I can refund you if you'd like — just let me know.",
  "Would you like me to cancel your subscription?",
  "I'll process your refund shortly.",
  "I've processed your request and someone will follow up.",
  "You cancelled your subscription last week, so there's nothing pending.",
  "I've changed my recommendation to the Hazelnut blend.",
  "I've added a note to your account for the team.",
  "Your order is on its way and should arrive Friday.",
  "Once you cancel, you'll lose your loyalty discount.",
  "Can you confirm the address you'd like this shipped to?",
  "",
];

test("blocks unbacked completed-effect claims", () => {
  for (const [msg, effect] of BLOCK) {
    assert.equal(unbackedEffectClaim(msg, NONE), effect, `should block: ${msg}`);
  }
});

test("allows offers, questions, future intent, and unrelated phrasing", () => {
  for (const msg of ALLOW) {
    assert.equal(unbackedEffectClaim(msg, NONE), null, `should allow: ${msg}`);
  }
});

test("allows a completed claim when a matching action backs it", () => {
  assert.equal(unbackedEffectClaim("I've refunded you $20.", new Set(["partial_refund"])), null);
  assert.equal(unbackedEffectClaim("I've cancelled your subscription.", new Set(["cancel"])), null);
  // but a DIFFERENT backing action does not excuse the claim
  assert.equal(unbackedEffectClaim("I've refunded you $20.", new Set(["change_next_date"])), "refund");
});
