/**
 * Phase 2 verification test for
 * [[../../docs/brain/specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]]
 * Verification bullet: "On the coffee-return ticket shape, Sol's first reply does not offer
 * two returns; it reflects the return policy (no coffee-subscription returns) and offers
 * the in-policy alternative — the reply never bais an outcome outside policy."
 *
 * Pins the machine gate builder-worker.ts runTicketHandleJob calls before the send fires.
 * Run: npx tsx --test src/lib/sol-policy-bait-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assessSolReplyBaitRisk } from "./sol-policy-bait-guard";

test("coffee-return shape: two-returns reply is BLOCKED (structural absurdity — cap is one MBG return per customer for life)", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary:
      "Customer received two coffee subscription renewals and wants to return both. Renewals not eligible per returns policy.",
    firstReply:
      "Thanks for reaching out — I'll set up two returns for you and send prepaid labels for each order. You should see your refund in 5-10 business days.",
  });
  assert.equal(res.ok, false, "coffee-return two-returns bait must be blocked");
  if (res.ok === false) {
    assert.equal(res.kind, "multiple_remedies_offered");
    assert.match(res.matched_phrase, /two\s+returns?/i);
  }
});

test("out-of-policy verdict + return promise → BLOCKED", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary:
      "Return of a subscription renewal is out-of-policy per returns.renewals_not_eligible.",
    firstReply: "I'll issue a refund for your renewal and send you a prepaid label right away.",
  });
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.kind, "out_of_policy_promise");
});

test("out-of-policy verdict phrased as 'not eligible' + we'll-refund promise → BLOCKED", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary: "Subscription renewals are not eligible for return under the MBG.",
    firstReply: "We'll process your refund and generate a prepaid label — you'll see the credit in 5-10 business days.",
  });
  assert.equal(res.ok, false);
});

test("in-policy verdict + in-policy remedy → PASSES (first-order MBG return)", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary:
      "First order return, in-policy under the 30-day MBG — customer within window, first-order eligibility confirmed.",
    firstReply:
      "I'll set up your return and send a prepaid label — refund lands 5-10 business days after we receive it.",
  });
  assert.equal(res.ok, true);
});

test("out-of-policy verdict + in-policy alternative (no promise, just explanation + options) → PASSES", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary:
      "Return of a subscription renewal is out-of-policy per returns.renewals_not_eligible.",
    firstReply:
      "Subscription renewals aren't eligible for return, but you can pause, skip, or cancel future renewals from your account. Let me know which option works best.",
  });
  assert.equal(res.ok, true);
});

test("empty reply → PASSES (nothing to bait, delivery is a no-op anyway)", () => {
  const res = assessSolReplyBaitRisk({ contextSummary: "out-of-policy", firstReply: "" });
  assert.equal(res.ok, true);
});

test("both signals present (out-of-policy + two returns) → BLOCKED by structural signal first", () => {
  const res = assessSolReplyBaitRisk({
    contextSummary: "Return of a subscription renewal is out-of-policy.",
    firstReply: "I'll issue two refunds and send you both prepaid labels.",
  });
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.kind, "multiple_remedies_offered");
});
