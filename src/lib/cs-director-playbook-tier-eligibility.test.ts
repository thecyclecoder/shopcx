/**
 * Unit tests for the pure evaluator in
 * [[./cs-director-playbook-tier-eligibility]] — the tier-ladder gate June's cs-director-call
 * runner consults before emitting `escalate_founder` on an out-of-policy refund/return.
 *
 * Verification mirror (docs/brain/specs/cs-director-treats-tier-eligible-out-of-policy-refund-as-
 * playbook-offer-not-escalation.md Phase 1):
 *   - Fixture matching ticket 87ce35a1 (LTV $1,569, 19 orders, no disqualifier) → BOTH tiers
 *     match, eligible_for_offer=true (the correct "approve_remedy back into offer_exception"
 *     path).
 *   - A customer clearing NO tier (LTV $50, 1 order) → matched_tiers empty,
 *     eligible_for_offer=false (still escalates).
 *   - A tier-eligible customer with a disqualifier (has_chargeback=true) →
 *     disqualifiers_active carries the reason, eligible_for_offer=false (still escalates).
 *   - Playbook rows carry the thresholds; the evaluator NEVER hardcodes them — the fixture
 *     conditions mirror the seeded rows in
 *     supabase/migrations/20260403310000_seed_default_playbooks.sql verbatim.
 *
 * Pure — no network, no DB. Run:
 *   npx tsx --test src/lib/cs-director-playbook-tier-eligibility.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  customerMatchesConditions,
  describeConditions,
  evaluatePlaybookTiers,
  formatPlaybookTierBrief,
  type CustomerTierStats,
  type DisqualifierState,
  type PlaybookExceptionRow,
  type PlaybookRow,
} from "./cs-director-playbook-tier-eligibility";

// ── Fixtures — mirror the seeded Refund playbook (Tier 1 store_credit_return, Tier 2 refund_return)
// exactly as supabase/migrations/20260403310000_seed_default_playbooks.sql writes them, so the
// evaluator gate here is testing against the SAME thresholds the runtime playbook executor enforces.

const REFUND_PLAYBOOK: PlaybookRow = {
  id: "pb-refund",
  name: "Unwanted Charge / Subscription Dispute",
  trigger_intents: ["unwanted_charge", "refund_request", "unauthorized_charge"],
  is_active: true,
  exception_disqualifiers: [
    { type: "previous_exception", source: "playbook" },
    { type: "has_chargeback" },
    { type: "has_chargeback_on_order", blocks: "in_policy_return" },
  ],
};

const REFUND_TIER_EXCEPTIONS: PlaybookExceptionRow[] = [
  {
    id: "ex-tier1",
    playbook_id: "pb-refund",
    tier: 1,
    name: "Return for Store Credit",
    conditions: { or: [{ ltv_cents: { ">=": 30000 } }, { total_orders: { ">=": 3 } }] },
    resolution_type: "store_credit_return",
    instructions: "Lead with this option.",
  },
  {
    id: "ex-tier2",
    playbook_id: "pb-refund",
    tier: 2,
    name: "Return for Full Refund",
    conditions: { or: [{ ltv_cents: { ">=": 30000 } }, { total_orders: { ">=": 3 } }] },
    resolution_type: "refund_return",
    instructions: "Only offer this if store credit rejected.",
  },
  {
    // Auto-grant rows (tier 0) never surface as a customer-facing offer — the evaluator must skip them.
    id: "ex-autogrant",
    playbook_id: "pb-refund",
    tier: 0,
    name: "System Error — Refund Without Return",
    conditions: {},
    resolution_type: "refund_no_return",
    instructions: null,
  },
];

const NO_DISQUALIFIERS: DisqualifierState = {
  previous_exception: false,
  has_chargeback: false,
  has_chargeback_on_order: false,
};

test("ticket 87ce35a1 fixture — LTV $1569, 19 orders, no disqualifier → both tiers match, eligible_for_offer=true", () => {
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, NO_DISQUALIFIERS);

  assert.equal(result.eligible_for_offer, true, "customer clears a tier with no disqualifier → eligible_for_offer=true");
  assert.equal(result.matched_tiers.length, 2, "both Tier 1 + Tier 2 should match this LTV/orders customer");
  assert.equal(result.unmatched_tiers.length, 0);
  assert.equal(result.disqualifiers_active.length, 0);

  const tier1 = result.matched_tiers.find((t) => t.tier === 1);
  const tier2 = result.matched_tiers.find((t) => t.tier === 2);
  assert.ok(tier1, "Tier 1 should be matched");
  assert.ok(tier2, "Tier 2 should be matched");
  assert.equal(tier1.resolution_type, "store_credit_return");
  assert.equal(tier2.resolution_type, "refund_return");
  // The `matches_why` must cite the concrete predicate that fired so June's brief shows the
  // grounding — never a paraphrase.
  assert.match(tier1.matches_why, /LTV \$1569\.00.*≥/);
});

test("auto-grant (tier=0) rows are excluded from the customer-facing tier ladder", () => {
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, NO_DISQUALIFIERS);
  const zeroTierRows = [...result.matched_tiers, ...result.unmatched_tiers].filter((t) => t.tier === 0);
  assert.equal(zeroTierRows.length, 0, "tier=0 auto-grant rows must never appear in the tier ladder");
});

test("customer clearing NO tier (LTV $50, 1 order) → matched_tiers empty, eligible_for_offer=false", () => {
  const stats: CustomerTierStats = { ltv_cents: 5000, total_orders: 1, retention_score: 0 };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, NO_DISQUALIFIERS);

  assert.equal(result.eligible_for_offer, false, "a customer clearing NO tier must still escalate");
  assert.equal(result.matched_tiers.length, 0);
  assert.equal(result.unmatched_tiers.length, 2, "both tiers should record why they didn't match");
  const t1 = result.unmatched_tiers.find((t) => t.tier === 1);
  assert.ok(t1);
  assert.match(t1.matches_why, /LTV \$50\.00 <.*OR.*orders < 3/);
});

test("tier-eligible customer with has_chargeback disqualifier → eligible_for_offer=false, reason cited", () => {
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const disq: DisqualifierState = { previous_exception: false, has_chargeback: true, has_chargeback_on_order: true };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, disq);

  assert.equal(result.eligible_for_offer, false, "any active disqualifier defeats tier eligibility");
  assert.ok(result.disqualifiers_active.some((r) => r.startsWith("has_chargeback")));
  assert.equal(result.matched_tiers.length, 2, "the tier evaluation still runs — the disqualifier is a separate gate");
});

test("tier-eligible customer with previous_exception disqualifier → eligible_for_offer=false", () => {
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const disq: DisqualifierState = { previous_exception: true, has_chargeback: false, has_chargeback_on_order: false };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, disq);

  assert.equal(result.eligible_for_offer, false);
  assert.ok(
    result.disqualifiers_active.some((r) => r.startsWith("previous_exception")),
    "previous_exception disqualifier must surface in the reasons list",
  );
});

test("thresholds are read from the playbook rows, not hardcoded — swapping conditions swaps the gate", () => {
  const strictTier: PlaybookExceptionRow[] = [
    {
      id: "ex-strict",
      playbook_id: "pb-refund",
      tier: 1,
      name: "Strict Tier",
      // Deliberately different thresholds — if the evaluator were hardcoded to the $300/3-order
      // seed values it would still match here; instead it MUST honor the passed-in threshold.
      conditions: { ltv_cents: { ">=": 500_000 } },
      resolution_type: "store_credit_return",
      instructions: null,
    },
  ];
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const result = evaluatePlaybookTiers(REFUND_PLAYBOOK, strictTier, stats, NO_DISQUALIFIERS);
  assert.equal(result.eligible_for_offer, false, "$1569 LTV must fail the $5000 threshold passed in");
  assert.equal(result.matched_tiers.length, 0);
});

test("customerMatchesConditions handles OR + AND + retention_score", () => {
  const stats: CustomerTierStats = { ltv_cents: 20_000, total_orders: 2, retention_score: 80 };
  assert.equal(
    customerMatchesConditions({ or: [{ ltv_cents: { ">=": 100_000 } }, { total_orders: { ">=": 3 } }] }, stats).matches,
    false,
  );
  assert.equal(
    customerMatchesConditions({ or: [{ ltv_cents: { ">=": 10_000 } }, { total_orders: { ">=": 3 } }] }, stats).matches,
    true,
  );
  assert.equal(
    customerMatchesConditions({ retention_score: { ">=": 50 } }, stats).matches,
    true,
  );
  assert.equal(
    customerMatchesConditions({}, stats).matches,
    true,
    "empty conditions object must match (an unconditional exception)",
  );
});

test("describeConditions renders the OR tree with dollar-formatted LTV thresholds", () => {
  const s = describeConditions({ or: [{ ltv_cents: { ">=": 30_000 } }, { total_orders: { ">=": 3 } }] });
  assert.equal(s, "LTV ≥ $300.00 OR orders ≥ 3");
});

test("formatPlaybookTierBrief renders the RULE and the tier-eligible-for-offer flag June's prompt consults", () => {
  const stats: CustomerTierStats = { ltv_cents: 156_900, total_orders: 19, retention_score: 0 };
  const evals = [evaluatePlaybookTiers(REFUND_PLAYBOOK, REFUND_TIER_EXCEPTIONS, stats, NO_DISQUALIFIERS)];
  const brief = formatPlaybookTierBrief(evals, stats);
  assert.match(brief, /PLAYBOOK EXCEPTION-TIER ELIGIBILITY/);
  assert.match(brief, /eligible_for_offer=true/);
  assert.match(brief, /Tier 1 "Return for Store Credit" → store_credit_return/);
  assert.match(brief, /Tier 2 "Return for Full Refund" → refund_return/);
  assert.match(brief, /RULE.*approve_remedy routing back into the playbook's offer_exception step, NOT escalate_founder/);
});

test("formatPlaybookTierBrief handles no-customer case gracefully", () => {
  const brief = formatPlaybookTierBrief([], null);
  assert.match(brief, /no linked customer — tier evaluation skipped/);
});
