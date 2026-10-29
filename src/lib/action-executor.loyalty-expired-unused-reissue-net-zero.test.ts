/**
 * Net-zero reissue tests (spec:
 * loyalty-expired-unused-reissue-must-be-net-zero-never-fresh-redeem-points).
 *
 * The bug (ticket 67eb2e40, Susan Krueger): she had three EXPIRED-UNUSED $15
 * loyalty coupons that the CEO 2026-08-28 policy requires be reissued at NO
 * points cost. Instead Sol T3 fired `redeem_points` (tier 2), minting a
 * BRAND-NEW LOYALTY-15-U4WVAD for a fresh 1,500 pts (27,010 → 25,510) and
 * applied it to the active sub — double-charging points for value she already
 * owned. Two structural gaps:
 *
 *   Gap 1 — nothing steered `redeem_points` to the net-zero expired-code
 *           reissue path when expired-unused coupons of the requested value
 *           already exist.
 *   Gap 2 — the net-zero reissue path (apply_loyalty_coupon → regen fallback)
 *           was unreachable once the sub already carried another loyalty
 *           coupon, because the one-coupon-per-sub stacking guard refused the
 *           apply before the regen fallback could run.
 *
 * These pure tests pin the two shared predicates the fixes added:
 *   • `isReissuableExpiredRedemptionRow` — the single definition of a
 *     reissuable expired-unused redemption (active + past-expiry).
 *   • `findReissuableExpiredLoyaltyRedemptions` — the `redeem_points` guard's
 *     lookup (gap 1).
 *   • `isReissuableExpiredLoyaltyCode` — the stacking-guard carve-out (gap 2).
 *
 * No live DB / Shopify — an in-memory admin fake drives the two DB readers.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.loyalty-expired-unused-reissue-net-zero.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReissuableExpiredRedemptionRow,
  findReissuableExpiredLoyaltyRedemptions,
  isReissuableExpiredLoyaltyCode,
} from "./action-executor";

const NOW = Date.parse("2026-10-29T00:00:00.000Z");
const PAST = "2026-10-02T00:00:00.000Z"; // one of Susan's expiries
const FUTURE = "2026-12-07T00:00:00.000Z";

// ─── Pure predicate ───────────────────────────────────────────────────

test("isReissuableExpiredRedemptionRow: active + past-expiry → reissuable (Susan's expired-unused coupon)", () => {
  assert.equal(isReissuableExpiredRedemptionRow({ status: "active", expires_at: PAST }, NOW), true);
});

test("isReissuableExpiredRedemptionRow: active but NOT yet expired → not reissuable (still a live coupon)", () => {
  assert.equal(isReissuableExpiredRedemptionRow({ status: "active", expires_at: FUTURE }, NOW), false);
});

test("isReissuableExpiredRedemptionRow: non-active status can't be claimed by the regen path", () => {
  assert.equal(isReissuableExpiredRedemptionRow({ status: "rolled_back", expires_at: PAST }, NOW), false);
  assert.equal(isReissuableExpiredRedemptionRow({ status: "expired", expires_at: PAST }, NOW), false);
  assert.equal(isReissuableExpiredRedemptionRow({ status: "applied", expires_at: PAST }, NOW), false);
});

test("isReissuableExpiredRedemptionRow: null / missing expiry → false (never crashes)", () => {
  assert.equal(isReissuableExpiredRedemptionRow(null, NOW), false);
  assert.equal(isReissuableExpiredRedemptionRow({ status: "active" }, NOW), false);
  assert.equal(isReissuableExpiredRedemptionRow({ status: "active", expires_at: 1234 }, NOW), false);
});

// ─── In-memory admin fake ───────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeChain(rows: Row[]) {
  const filters: Array<{ col: string; val: unknown }> = [];
  const matched = () => rows.filter((r) => filters.every((f) => r[f.col] === f.val));
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters.push({ col, val });
      return chain;
    },
    maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
    then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve({ data: matched(), error: null }).then(onFulfilled),
  };
  return chain;
}

function makeAdmin(loyaltyRedemptions: Row[]) {
  return {
    from: (t: string) => {
      if (t !== "loyalty_redemptions") throw new Error(`unexpected table ${t}`);
      return makeChain(loyaltyRedemptions);
    },
  } as unknown as Parameters<typeof findReissuableExpiredLoyaltyRedemptions>[0];
}

// Susan's three expired-unused $15 coupons + the wrongly-minted fresh one.
function seedSusan(): Row[] {
  return [
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-15-JKRJJ4", discount_value: 15, status: "active", expires_at: "2026-07-29T00:00:00.000Z" },
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-15-J774FJ", discount_value: 15, status: "active", expires_at: PAST },
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-15-V9VMZB", discount_value: 15, status: "active", expires_at: PAST },
    // The fresh double-charge mint — active but NOT expired, so NOT reissuable.
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-15-U4WVAD", discount_value: 15, status: "active", expires_at: FUTURE },
  ];
}

// ─── Gap 1: redeem_points guard lookup ──────────────────────────────────

test("findReissuableExpiredLoyaltyRedemptions: returns Susan's three expired $15 coupons, NOT the fresh live one", async () => {
  const found = await findReissuableExpiredLoyaltyRedemptions(makeAdmin(seedSusan()), "ws", "mem-susan", 15, NOW);
  const codes = found.map((f) => f.discount_code).sort();
  assert.deepEqual(codes, ["LOYALTY-15-J774FJ", "LOYALTY-15-JKRJJ4", "LOYALTY-15-V9VMZB"]);
  assert.ok(!codes.includes("LOYALTY-15-U4WVAD"), "the still-live fresh mint is not a reissue candidate");
});

test("findReissuableExpiredLoyaltyRedemptions: value + workspace + member scoped", async () => {
  const rows: Row[] = [
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-25-AAAAAA", discount_value: 25, status: "active", expires_at: PAST },
    { workspace_id: "ws", member_id: "mem-other", discount_code: "LOYALTY-15-BBBBBB", discount_value: 15, status: "active", expires_at: PAST },
    { workspace_id: "ws2", member_id: "mem-susan", discount_code: "LOYALTY-15-CCCCCC", discount_value: 15, status: "active", expires_at: PAST },
  ];
  // Asking for $15 on mem-susan/ws: none of the above match (wrong value / member / workspace).
  const found = await findReissuableExpiredLoyaltyRedemptions(makeAdmin(rows), "ws", "mem-susan", 15, NOW);
  assert.equal(found.length, 0);
});

test("findReissuableExpiredLoyaltyRedemptions: no expired coupons → empty (fresh redeem is allowed through)", async () => {
  const rows: Row[] = [
    { workspace_id: "ws", member_id: "mem-susan", discount_code: "LOYALTY-15-LIVE01", discount_value: 15, status: "active", expires_at: FUTURE },
  ];
  const found = await findReissuableExpiredLoyaltyRedemptions(makeAdmin(rows), "ws", "mem-susan", 15, NOW);
  assert.equal(found.length, 0, "with no expired-unused coupon, the guard does not block a legitimate first redemption");
});

// ─── Gap 2: stacking-guard carve-out ────────────────────────────────────

test("isReissuableExpiredLoyaltyCode: an expired-unused code IS a reissue → stacking guard must let it through", async () => {
  const ok = await isReissuableExpiredLoyaltyCode(makeAdmin(seedSusan()), "ws", "LOYALTY-15-J774FJ", NOW);
  assert.equal(ok, true);
});

test("isReissuableExpiredLoyaltyCode: a still-live code is NOT a reissue → stacking guard still refuses it", async () => {
  const ok = await isReissuableExpiredLoyaltyCode(makeAdmin(seedSusan()), "ws", "LOYALTY-15-U4WVAD", NOW);
  assert.equal(ok, false);
});

test("isReissuableExpiredLoyaltyCode: unknown code → false (never crashes)", async () => {
  const ok = await isReissuableExpiredLoyaltyCode(makeAdmin(seedSusan()), "ws", "LOYALTY-15-NOPE00", NOW);
  assert.equal(ok, false);
});
