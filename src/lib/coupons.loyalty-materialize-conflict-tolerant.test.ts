/**
 * Phase "Fix 1" regression harness for
 * loyalty-coupon-materialize-conflict-tolerant-insert.
 *
 * The expected concurrent-materialization race: two coupon-apply paths
 * materialize the SAME loyalty code at the same time. Pre-fix, the losing
 * `.from("coupons").insert()` tripped the `coupons_workspace_code_idx` unique
 * index and Postgres logged a unique-violation ERROR on every race (harmless
 * to customers, but an open Control Tower signature —
 * supabase-logs:bbd5f21ef9289c31). The fix routes the write through the
 * SECURITY DEFINER RPC `insert_coupon_on_conflict_ignore`
 * (INSERT … ON CONFLICT (workspace_id, lower(code)) DO NOTHING RETURNING id):
 * the loser gets a `null` id back (no ERROR) and the caller's readExisting()
 * fallback resolves the winner's row.
 *
 * This harness invokes the materialize insert TWICE for the same
 * (workspace_id, code) against an in-memory admin fake that models the unique
 * index inside the RPC. It asserts:
 *   (1) neither call throws a unique-violation,
 *   (2) the winning call returns the coupon id,
 *   (3) the losing call returns null (the ON CONFLICT DO NOTHING case),
 *   (4) the winner's row is readable by (workspace_id, lower(code)) — the row
 *       the real caller's readExisting() fallback resolves — so both apply
 *       paths converge on the SAME coupon id.
 *
 * Pure — no live DB. Run:
 *   npx tsx --test src/lib/coupons.loyalty-materialize-conflict-tolerant.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { insertInternalLoyaltyCouponRowUnchecked } from "./coupons";

type Row = Record<string, unknown>;

/**
 * In-memory admin fake. The RPC enforces the (workspace_id, lower(code))
 * unique index the SAME way the real `insert_coupon_on_conflict_ignore`
 * SECURITY DEFINER function does: a colliding insert is a no-op returning a
 * null id — it never throws. A read chain
 * `.from("coupons").select(...).eq(...).ilike("code", code).limit(1)` backs the
 * caller's readExisting() fallback.
 */
function makeAdmin(seedCoupons: Row[] = []) {
  const coupons: Row[] = [...seedCoupons];
  let nextId = 1;

  function keyOf(workspaceId: unknown, code: unknown): string {
    return `${String(workspaceId)}::${String(code).toLowerCase()}`;
  }

  function chain(table: string) {
    const eqs: Array<[string, unknown]> = [];
    let ilikeCol: string | null = null;
    let ilikeVal: string | null = null;

    function filtered(): Row[] {
      let rows = (table === "coupons" ? coupons : []).filter((r) =>
        eqs.every(([c, v]) => r[c] === v),
      );
      if (ilikeCol !== null) {
        const col = ilikeCol;
        rows = rows.filter((r) => String(r[col]).toLowerCase() === String(ilikeVal).toLowerCase());
      }
      return rows;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api: any = {
      select() { return api; },
      eq(col: string, val: unknown) { eqs.push([col, val]); return api; },
      ilike(col: string, val: string) { ilikeCol = col; ilikeVal = val; return api; },
      limit() { return api; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve({ data: filtered(), error: null }).then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function rpc(fn: string, params: Record<string, any>) {
    if (fn !== "insert_coupon_on_conflict_ignore") {
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    }
    const key = keyOf(params.p_workspace_id, params.p_code);
    const exists = coupons.some((r) => keyOf(r.workspace_id, r.code) === key);
    if (exists) {
      // ON CONFLICT DO NOTHING RETURNING id → zero rows → null id. No throw.
      return Promise.resolve({ data: null, error: null });
    }
    const id = `coupon-${nextId++}`;
    coupons.push({
      id,
      workspace_id: params.p_workspace_id,
      code: params.p_code,
      type: params.p_type,
      value: params.p_value,
      scope: params.p_scope,
      recurring_cycle_limit: params.p_recurring_cycle_limit,
      customer_id: params.p_customer_id,
      single_use: params.p_single_use,
    });
    return Promise.resolve({ data: id, error: null });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => chain(t), rpc } as any;
}

const WS = "ws-1";
const OWNER = "cust-owner";
const CODE = "LOYALTY-15-UP77G3";
const VALUE_CENTS = 1500;

test("concurrent materialize: winner inserts, loser returns null, both resolve to the same id — no unique-violation", async () => {
  const admin = makeAdmin();

  // First apply path wins the insert.
  const first = await insertInternalLoyaltyCouponRowUnchecked(admin, WS, CODE, OWNER, VALUE_CENTS);
  assert.ok(first, "winning materialize should return the inserted row");
  assert.equal(first!.source, "internal");
  assert.equal(first!.value, VALUE_CENTS);
  const winnerId = first!.coupon_id;
  assert.ok(winnerId, "winner should carry a coupon id");

  // Second apply path loses the race — ON CONFLICT DO NOTHING → null id, NO throw.
  const second = await insertInternalLoyaltyCouponRowUnchecked(admin, WS, CODE, OWNER, VALUE_CENTS);
  assert.equal(second, null, "losing concurrent materialize must return null, not throw a unique-violation");

  // The winner's row is readable by (workspace_id, lower(code)) — this is the
  // row the real caller's readExisting() fallback resolves, so both apply
  // paths converge on the SAME coupon id.
  const { data: rows } = await admin
    .from("coupons")
    .select("id")
    .eq("workspace_id", WS)
    .ilike("code", CODE)
    .limit(1);
  assert.equal(rows.length, 1, "exactly one coupon row should exist after two concurrent materializes");
  assert.equal(rows[0].id, winnerId, "the readExisting fallback must resolve the winner's id");
});

test("case-insensitive collision: a differently-cased code still hits ON CONFLICT (no duplicate row)", async () => {
  const admin = makeAdmin();
  const first = await insertInternalLoyaltyCouponRowUnchecked(admin, WS, CODE, OWNER, VALUE_CENTS);
  assert.ok(first);
  const second = await insertInternalLoyaltyCouponRowUnchecked(admin, WS, CODE.toLowerCase(), OWNER, VALUE_CENTS);
  assert.equal(second, null, "lower-cased duplicate must conflict on lower(code) and return null");

  const { data: rows } = await admin
    .from("coupons")
    .select("id")
    .eq("workspace_id", WS)
    .ilike("code", CODE)
    .limit(1);
  assert.equal(rows.length, 1, "case-insensitive unique index must prevent a second row");
});
