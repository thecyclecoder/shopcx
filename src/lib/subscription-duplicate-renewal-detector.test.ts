/**
 * Phase 2 of docs/brain/specs/immediate-charge-renewal-paths-need-per-subscription-idempotency.md.
 *
 * Pins the pure `detectDuplicateRenewalGroups` grouping semantics against the ground-truth shape
 * that produced the spec: SHOPCX273 (17:18:44 UTC) + SHOPCX274 (17:22:56 UTC) on 2026-08-28, same
 * subscription_id, same $102.33, both `source_name='internal_subscription_renewal'`. The detector
 * must:
 *
 *   1. Group the two same-day same-subscription renewal orders into ONE group.
 *   2. Ignore non-`internal_subscription_renewal` rows (a manual admin order on the same day is NOT
 *      a duplicate renewal — the detector's whole job is to spot RENEWAL doubles, not any two
 *      orders on the same day).
 *   3. Ignore rows missing subscription_id / workspace_id — a bad row must not crash the sweep or
 *      corrupt a group.
 *   4. Ignore rows with an unparseable created_at — same reason.
 *   5. Return NO group for a subscription with exactly ONE renewal on the day (the happy path —
 *      most renewals — must not surface as an alert).
 *   6. Sort each group's orders ASCENDING by created_at, so the earliest (the one that "should
 *      have" won the cycle) is first — the surface function relies on this ordering to build the
 *      "@ hh:mm:ss" list in chronological order.
 *   7. Bucket ACROSS midnight — a duplicate that spans day rollover splits into two 1-order
 *      buckets and does NOT surface, which is intentional per the docstring ("same-day is a
 *      deliberate simplification"). This test pins the current behavior so a future widen to
 *      "same-cycle" is a deliberate change with a failing test to update.
 *
 * Pure function, no I/O — a direct import.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-duplicate-renewal-detector.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectDuplicateRenewalGroups,
  type RenewalOrderLike,
} from "./subscription-duplicate-renewal-detector";

const WS = "11111111-1111-1111-1111-111111111111";
const SUB_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUB_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CUST = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function o(overrides: Partial<RenewalOrderLike>): RenewalOrderLike {
  // `in` (not `??`) so an explicit `null` override is preserved — the bad-row tests below rely on
  // passing `workspace_id: null` / `subscription_id: null` and getting a row the detector rejects.
  return {
    id: "id" in overrides ? (overrides.id as string) : "order-x",
    workspace_id: "workspace_id" in overrides ? (overrides.workspace_id as string | null) : WS,
    customer_id: "customer_id" in overrides ? (overrides.customer_id as string | null) : CUST,
    subscription_id: "subscription_id" in overrides ? (overrides.subscription_id as string | null) : SUB_A,
    order_number: "order_number" in overrides ? (overrides.order_number as string | null) : null,
    total_cents: "total_cents" in overrides ? (overrides.total_cents as number | null) : 10233,
    source_name: "source_name" in overrides ? (overrides.source_name as string | null) : "internal_subscription_renewal",
    financial_status: "financial_status" in overrides ? (overrides.financial_status as string | null) : "paid",
    created_at: "created_at" in overrides ? (overrides.created_at as string) : "2026-08-28T17:18:44Z",
  };
}

test("Phase 2: SHOPCX273/274 shape — two same-day same-subscription renewal orders form ONE group", () => {
  const orders: RenewalOrderLike[] = [
    o({ id: "order-273", order_number: "SHOPCX273", created_at: "2026-08-28T17:18:44Z" }),
    o({ id: "order-274", order_number: "SHOPCX274", created_at: "2026-08-28T17:22:56Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 1, "the two duplicate renewals must produce exactly one group");
  const g = groups[0];
  assert.equal(g.subscription_id, SUB_A);
  assert.equal(g.workspace_id, WS);
  assert.equal(g.cycle_day, "2026-08-28");
  assert.equal(g.orders.length, 2);
  // Chronological: SHOPCX273 (earlier) first, SHOPCX274 (later) second — the surface function
  // relies on this ordering.
  assert.equal(g.orders[0].order_number, "SHOPCX273");
  assert.equal(g.orders[1].order_number, "SHOPCX274");
});

test("Phase 2: a lone renewal on the day does NOT surface — the happy path stays silent", () => {
  const orders: RenewalOrderLike[] = [
    o({ id: "order-solo", order_number: "SHOPCX999", created_at: "2026-08-28T17:00:00Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 0, "no duplicate, no group — the detector must not fire on the happy path");
});

test("Phase 2: two orders on the same day but ONE is a non-renewal is NOT grouped", () => {
  // A manual admin order + a real renewal on the same day should NOT be flagged — the detector's
  // job is to spot RENEWAL doubles, not any two orders. Only the renewal contributes to the
  // bucket, and the lone bucket falls below the >=2 threshold.
  const orders: RenewalOrderLike[] = [
    o({ id: "order-manual", source_name: "admin_manual_order", created_at: "2026-08-28T10:00:00Z" }),
    o({ id: "order-renewal", order_number: "SHOPCX273", created_at: "2026-08-28T17:18:44Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 0, "a manual order + a renewal on the same day is NOT a duplicate renewal");
});

test("Phase 2: two renewals on the same day for DIFFERENT subs are TWO separate one-item buckets, neither surfaces", () => {
  const orders: RenewalOrderLike[] = [
    o({ id: "order-A", subscription_id: SUB_A, created_at: "2026-08-28T17:00:00Z" }),
    o({ id: "order-B", subscription_id: SUB_B, created_at: "2026-08-28T18:00:00Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 0, "one-per-sub is the normal daily fan-out — no duplicate to flag");
});

test("Phase 2: rows missing subscription_id / workspace_id are ignored (no crash, no corrupted group)", () => {
  const orders: RenewalOrderLike[] = [
    o({ id: "order-good-1", order_number: "SHOPCX273", created_at: "2026-08-28T17:18:44Z" }),
    o({ id: "order-good-2", order_number: "SHOPCX274", created_at: "2026-08-28T17:22:56Z" }),
    // Bad rows the sweep MUST tolerate:
    o({ id: "order-nowk", workspace_id: null, created_at: "2026-08-28T17:19:00Z" }),
    o({ id: "order-nosub", subscription_id: null, created_at: "2026-08-28T17:20:00Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orders.length, 2, "only the two good rows contribute — bad rows filtered");
});

test("Phase 2: an unparseable created_at is dropped (no NaN bucket, no crash)", () => {
  const orders: RenewalOrderLike[] = [
    o({ id: "order-good", order_number: "SHOPCX273", created_at: "2026-08-28T17:18:44Z" }),
    o({ id: "order-good-2", order_number: "SHOPCX274", created_at: "2026-08-28T17:22:56Z" }),
    o({ id: "order-bad-date", created_at: "not-a-date" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orders.length, 2, "the unparseable date row must not join a valid group or make its own");
});

test("Phase 2: two renewals split by UTC midnight go into SEPARATE day buckets — current behavior pin", () => {
  // Pins the documented "same-day is a deliberate simplification" behavior: 23:59Z and 00:01Z
  // (next day) split into two 1-item buckets, neither surfaces. If a future spec widens this to
  // "same billing cycle", this test flips to reflect the new invariant deliberately — not
  // silently.
  const orders: RenewalOrderLike[] = [
    o({ id: "order-late", created_at: "2026-08-28T23:59:00Z" }),
    o({ id: "order-early", created_at: "2026-08-29T00:01:00Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 0, "split-by-midnight is deliberately outside the detector's window");
});

test("Phase 2: THREE same-day renewals on one sub form ONE group with all three orders, sorted", () => {
  // A triple charge is even worse than the SHOPCX273/274 double — the detector must surface it
  // with all three orders present and sorted, so the alert body cites every offending order id.
  const orders: RenewalOrderLike[] = [
    o({ id: "order-mid", order_number: "SHOPCX274", created_at: "2026-08-28T17:22:56Z" }),
    o({ id: "order-late", order_number: "SHOPCX275", created_at: "2026-08-28T17:30:00Z" }),
    o({ id: "order-early", order_number: "SHOPCX273", created_at: "2026-08-28T17:18:44Z" }),
  ];
  const groups = detectDuplicateRenewalGroups(orders);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].orders.length, 3);
  assert.deepEqual(
    groups[0].orders.map((x) => x.order_number),
    ["SHOPCX273", "SHOPCX274", "SHOPCX275"],
    "orders must be sorted ASCENDING by created_at so the surface alert cites them in chronological order",
  );
});
