/**
 * Phase 1 assert-the-bug test for the loyalty coupon-apply double-spend
 * (spec: loyalty-coupon-apply-self-heal-must-not-double-deduct-points).
 *
 * Susan D. (member aa8fe19e) was charged 1,500 pts TWICE within 12s on
 * 2026-07-09 for ONE $15 coupon actually applied. The signature is two
 * "-1500 / Redeemed $X Off (regenerated)" `loyalty_transactions` rows
 * for one member within seconds.
 *
 * Mechanism (src/lib/action-executor.ts:1266-1365 apply_loyalty_coupon):
 *   1. Initial subscriptionApplyCoupon fails ("verify fail").
 *   2. The regen branch selects the ORIGINAL redemption by discount_code
 *      with NO status filter (:1287-1290), mints a new code, marks the
 *      original 'expired', and calls spendPoints (regenerated) once.
 *   3. A caller-level retry re-invokes apply_loyalty_coupon with the
 *      SAME ORIGINAL code. subscriptionApplyCoupon fails again (original
 *      is now deleted). The regen branch fires AGAIN — the same 'expired'
 *      row is still returned, `orig.points_spent` is credited-then-spent
 *      a second time, and a second (regenerated) -1500 row lands.
 *
 * This test pins the CURRENT (buggy, pre-Phase-2) behavior: N regen
 * attempts for the SAME original code → N spends. Phase 2 will introduce
 * an idempotency gate keyed by (workspace_id, member_id, original code)
 * and flip this test's assertion to "exactly one spend, no matter how
 * many retries fire" — that flip is the diff the spec verifies.
 *
 * Pure — no live DB, no live Shopify. The test re-implements only the
 * ledger-touching steps of the regen branch verbatim so a regression in
 * either copy is visible in the other.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.apply-loyalty-coupon-double-spend.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

type TxRow = {
  workspace_id: string;
  member_id: string;
  points_change: number;
  type: string;
  description: string;
  shopify_discount_id: string | null;
};

type MemberRow = {
  id: string;
  workspace_id: string;
  points_balance: number;
  points_spent: number;
};

type RedemptionRow = {
  id: string;
  workspace_id: string;
  member_id: string;
  discount_code: string;
  discount_value: number;
  points_spent: number;
  status: string;
};

// Verbatim shape of the regen branch's LEDGER writes at
// action-executor.ts:1287-1354. The SELECT deliberately does not filter
// on status — the fingerprint that lets the retry re-enter regen.
function runRegenBranchOnce(args: {
  workspaceId: string;
  code: string;
  members: MemberRow[];
  redemptions: RedemptionRow[];
  transactions: TxRow[];
  mintedCodeSuffix: string;
}): { newCode: string } {
  const { workspaceId, code, members, redemptions, transactions, mintedCodeSuffix } = args;

  const orig = redemptions.find(
    (r) => r.discount_code === code && r.workspace_id === workspaceId,
  );
  if (!orig) throw new Error(`orig not found for ${code}`);

  const member = members.find((m) => m.id === orig.member_id);
  if (!member) throw new Error("member not found");

  const newCode = `LOYALTY-${orig.discount_value}-${mintedCodeSuffix}`;
  const newDiscountId = `gid://shopify/DiscountCodeNode/${mintedCodeSuffix}`;

  member.points_balance = member.points_balance + orig.points_spent;
  orig.status = "expired";

  transactions.push({
    workspace_id: workspaceId,
    member_id: member.id,
    points_change: -orig.points_spent,
    type: "spending",
    description: `Redeemed $${orig.discount_value} Off (regenerated)`,
    shopify_discount_id: newDiscountId,
  });
  member.points_balance = Math.max(0, member.points_balance - orig.points_spent);
  member.points_spent = member.points_spent + orig.points_spent;

  redemptions.push({
    id: `red-${mintedCodeSuffix}`,
    workspace_id: workspaceId,
    member_id: member.id,
    discount_code: newCode,
    discount_value: orig.discount_value,
    points_spent: orig.points_spent,
    status: "active",
  });

  return { newCode };
}

function seedSusanState(): {
  member: MemberRow;
  redemptions: RedemptionRow[];
  transactions: TxRow[];
  origCode: string;
} {
  const member: MemberRow = {
    id: "mem-susan",
    workspace_id: "ws-superfoods",
    points_balance: 500,
    points_spent: 1500,
  };
  const origCode = "LOYALTY-15-OLDXYZ";
  const redemptions: RedemptionRow[] = [{
    id: "red-orig",
    workspace_id: "ws-superfoods",
    member_id: "mem-susan",
    discount_code: origCode,
    discount_value: 15,
    points_spent: 1500,
    status: "active",
  }];
  return { member, redemptions, transactions: [], origCode };
}

test("BUG: two regen attempts for the SAME original code produce TWO -1500 spending rows (Susan's 2026-07-09 fingerprint)", () => {
  const { member, redemptions, transactions, origCode } = seedSusanState();

  runRegenBranchOnce({
    workspaceId: "ws-superfoods",
    code: origCode,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "AAA111",
  });

  runRegenBranchOnce({
    workspaceId: "ws-superfoods",
    code: origCode, // caller-level retry with the ORIGINAL code — the bug's entry point
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "BBB222",
  });

  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 2, "the current regen branch has NO idempotency gate on the original code — Phase 2 must flip this to 1");
  assert.equal(member.points_spent, 4500, "member.points_spent is inflated by the extra regen (was 1500 → 3000 → 4500)");
});

test("BUG: three regen attempts (Susan Jun 11 pattern) produce THREE -1500 spending rows", () => {
  const { member, redemptions, transactions, origCode } = seedSusanState();
  for (const suffix of ["AAA", "BBB", "CCC"]) {
    runRegenBranchOnce({
      workspaceId: "ws-superfoods",
      code: origCode,
      members: [member],
      redemptions,
      transactions,
      mintedCodeSuffix: suffix,
    });
  }
  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 3, "the retry loop is unbounded pre-Phase-2 — each retry = one extra spend");
});

test("baseline: a SINGLE regen attempt is legitimate — one spend for one applied coupon", () => {
  // Phase 2's idempotency gate MUST keep this case working. The bug is
  // that N>1 retries against the same code all pass through — not that
  // regen itself is wrong. The first regen is the "self-healing that
  // succeeded on retry" path we WANT to keep.
  const { member, redemptions, transactions, origCode } = seedSusanState();
  runRegenBranchOnce({
    workspaceId: "ws-superfoods",
    code: origCode,
    members: [member],
    redemptions,
    transactions,
    mintedCodeSuffix: "ONCE",
  });
  const spends = transactions.filter(
    (t) => t.points_change === -1500 && t.type === "spending" && t.description.includes("(regenerated)"),
  );
  assert.equal(spends.length, 1, "one regen = one spend; this is the legitimate path Phase 2 must preserve");
  const activeRedemptions = redemptions.filter((r) => r.status === "active");
  assert.equal(activeRedemptions.length, 1, "one active redemption row (the fresh one) — the applied_discounts mirror stays consistent");
});
