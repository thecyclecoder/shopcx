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

// ── unverified_remedy_promise (ticket 879dd36b, 2026-08-12) ─────────────────────────────────
// The two original signals both assume we KNOW something: one needs a declared out-of-policy
// verdict, the other a stacked-remedy shape. Neither fires on a promise made under total
// IGNORANCE — which is the more dangerous case, because eligibility is unknown rather than
// known-bad. Mark McCartney's email matched no account; the reply promised a refund anyway.

test("unverified_remedy_promise — the EXACT 879dd36b sentence is blocked when the customer is unidentified", () => {
  const v = assessSolReplyBaitRisk({
    contextSummary: "Customer wants to cancel and get a refund. No account found under their email.",
    firstReply:
      "Hi Mark, thank you for providing your address. I want to make sure we get this sorted out for you — cancelling your deliveries and processing your refund are both things we can absolutely take care of.",
    customerIdentified: false,
  });
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.kind, "unverified_remedy_promise");
    assert.match(v.reason, /NOT identified/);
    assert.match(v.reason, /categorically denied|MBG|lifetime return/);
  }
});

test("the SAME sentence passes once the customer IS identified (the guard is about ignorance, not the words)", () => {
  const v = assessSolReplyBaitRisk({
    contextSummary: "In-policy: first order, within the 30-day window, no prior return.",
    firstReply: "cancelling your deliveries and processing your refund are both things we can absolutely take care of",
    customerIdentified: true,
  });
  assert.equal(v.ok, true);
});

test("acknowledging + asking to identify is NEVER blocked — only the promise is", () => {
  const v = assessSolReplyBaitRisk({
    contextSummary: "No account found under their email.",
    firstReply:
      "Thanks Mark — I can't find an account under that email. Was the order placed under a different email, or possibly a spouse's name or card?",
    customerIdentified: false,
  });
  assert.equal(v.ok, true, "the identify-first reply must always be sendable");
});

test("omitting customerIdentified preserves existing behaviour (defaults to identified)", () => {
  const v = assessSolReplyBaitRisk({
    contextSummary: "In-policy.",
    firstReply: "I'll issue a refund today.",
  });
  assert.equal(v.ok, true, "existing callers must not start blocking");
});
