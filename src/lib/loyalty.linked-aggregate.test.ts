/**
 * Regression: linked loyalty accounts report the SUM of balances across the
 * link group, not the max-pick (spec:
 * loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen
 * Phase 3, verification bar).
 *
 * Fingerprint: Sandra Lutz (ticket 2b7ea029) — the orchestrator's raw
 * `.in(customer_id, allCustIds).order(points_balance, desc).limit(1)`
 * picked the highest single profile's balance (100) instead of aggregating
 * across the group (100 + 51 = 151). Every loyalty reader now routes
 * through the [[../libraries/loyalty]] SDK chokepoint whose
 * `aggregateLinkedMembers` primitive SUMS the group — this test locks the
 * primitive in so any refactor that reverts to max-pick reds immediately.
 *
 * Pure — no live DB, no live Shopify. Tests the exported pure function.
 *
 * Run:
 *   npx tsx --test src/lib/loyalty.linked-aggregate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateLinkedMembers, type LoyaltyMember } from "./loyalty";

function member(overrides: Partial<LoyaltyMember>): LoyaltyMember {
  return {
    id: "mem-x",
    workspace_id: "ws-superfoods",
    customer_id: "uuid-x",
    shopify_customer_id: "shopify-x",
    email: "x@example.com",
    points_balance: 0,
    points_earned: 0,
    points_spent: 0,
    source: "native",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ─── The Sandra Lutz regression bar ──────────────────────────────────

test("SPEC BAR: two-member link group with SPLIT balance (100 + 51) reports 151 — the sum, not max-pick 100 (Sandra Lutz)", () => {
  const rows: LoyaltyMember[] = [
    member({ id: "mem-gmail", customer_id: "uuid-gmail", email: "sandra@gmail.com", points_balance: 100, points_earned: 100 }),
    member({ id: "mem-yahoo", customer_id: "uuid-yahoo", email: "sandra@yahoo.com", points_balance: 51, points_earned: 51 }),
  ];
  const agg = aggregateLinkedMembers(rows);
  assert.ok(agg, "must return the aggregated canonical row, not null");
  assert.equal(agg!.points_balance, 151, "the aggregate MUST be the sum across the group; a max-pick would return 100");
  assert.equal(agg!.points_earned, 151, "points_earned aggregates identically");
});

test("aggregated canonical identity is the HIGHEST-BALANCE row (100 wins over 51)", () => {
  const rows: LoyaltyMember[] = [
    member({ id: "mem-gmail", customer_id: "uuid-gmail", email: "sandra@gmail.com", points_balance: 100 }),
    member({ id: "mem-yahoo", customer_id: "uuid-yahoo", email: "sandra@yahoo.com", points_balance: 51 }),
  ];
  const agg = aggregateLinkedMembers(rows);
  assert.equal(agg!.id, "mem-gmail", "canonical identity is the biggest current holder — future earn/spend targets THIS row");
  assert.equal(agg!.email, "sandra@gmail.com");
});

test("single-member group returns that member verbatim (no aggregation math)", () => {
  const single = member({ points_balance: 250, points_earned: 300 });
  const agg = aggregateLinkedMembers([single]);
  assert.equal(agg, single, "1-row shortcut returns the same reference — no allocation, no copy");
});

test("empty group returns null (no linked-accounts row exists for this customer)", () => {
  assert.equal(aggregateLinkedMembers([]), null);
});

test("three-member group sums all three (73 + 40 + 38 → 151, matches Sandra's total even with a different split)", () => {
  const rows: LoyaltyMember[] = [
    member({ id: "mem-a", points_balance: 73 }),
    member({ id: "mem-b", points_balance: 40 }),
    member({ id: "mem-c", points_balance: 38 }),
  ];
  const agg = aggregateLinkedMembers(rows);
  assert.equal(agg!.points_balance, 151);
  assert.equal(agg!.id, "mem-a", "canonical is still the highest of the three");
});

test("zero-balance sibling contributes nothing but is still counted (no divide-by-zero, no drop)", () => {
  const rows: LoyaltyMember[] = [
    member({ id: "mem-holder", points_balance: 151 }),
    member({ id: "mem-empty", points_balance: 0 }),
  ];
  const agg = aggregateLinkedMembers(rows);
  assert.equal(agg!.points_balance, 151);
  assert.equal(agg!.id, "mem-holder");
});

test("null / missing points_balance coerces to 0, does not crash or NaN the sum", () => {
  const rows: LoyaltyMember[] = [
    member({ id: "mem-a", points_balance: 100 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    member({ id: "mem-b", points_balance: null as any }),
    member({ id: "mem-c", points_balance: 51 }),
  ];
  const agg = aggregateLinkedMembers(rows);
  assert.equal(agg!.points_balance, 151, "null balance is treated as 0 — sum stays 151");
  assert.ok(!Number.isNaN(agg!.points_balance));
});
