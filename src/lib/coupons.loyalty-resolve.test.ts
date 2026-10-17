/**
 * Unit test for Phase 2 of
 * loyalty-apply-to-subscription-spends-points-only-on-success:
 * a freshly minted loyalty code materialized into our own `coupons` table
 * (customer-scoped, single_use, fixed_amount) resolves via `resolveCoupon`
 * step 1 (internal wins) FOR ITS OWNER — and definitively does NOT resolve
 * for another customer, nor when no customer is supplied.
 *
 * This is the invariant Michelle Zumwalt's bug violated: on an internal sub
 * the Shopify-only code returned `coupon_not_found`. Once the code lives in
 * our coupons table scoped to the owning customer, resolution no longer
 * depends on the Shopify lookup at all. The apply path materializes that row
 * via `ensureInternalLoyaltyCouponRow` (src/lib/subscription-items.ts) and
 * then calls `resolveCoupon` with the SAME contract-owner customerId that the
 * row is scoped to.
 *
 * Pure — no live DB. Uses an in-memory fake admin injected through the
 * `resolveCoupon` admin DI seam. Run:
 *   npx tsx --test src/lib/coupons.loyalty-resolve.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCoupon } from "./coupons";

type Row = Record<string, unknown>;

// Minimal fake admin covering the single chain `resolveCouponDetailed` step 1
// uses: from(table).select(...).eq(...).ilike("code", code).limit(1) → awaited
// to `{ data: Row[], error: null }`. The owner/stranger assertions return
// inside step 1, so no derived-master or Shopify step is ever reached.
function makeAdmin(tables: Record<string, Row[]>) {
  function chain(table: string) {
    const eqs: Array<[string, unknown]> = [];
    let ilikeCol: string | null = null;
    let ilikeVal: string | null = null;

    function filtered(): Row[] {
      let rows = (tables[table] || []).filter((r) => eqs.every(([c, v]) => r[c] === v));
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
      maybeSingle() { return Promise.resolve({ data: filtered()[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: filtered()[0] ?? null, error: null }); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then(onFulfilled: any, onRejected: any) {
        return Promise.resolve({ data: filtered(), error: null }).then(onFulfilled, onRejected);
      },
    };
    return api;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: (t: string) => chain(t) } as any;
}

const WS = "ws-1";
const OWNER = "cust-owner";
const STRANGER = "cust-stranger";
const CODE = "LOYALTY-15-UP77G3";

function seed() {
  return makeAdmin({
    coupons: [
      {
        id: "coupon-1",
        code: CODE,
        type: "fixed_amount",
        value: 1500, // tier.discount_value ($15) * 100 — cents
        recurring_cycle_limit: 1,
        customer_id: OWNER,
        single_use: true,
        used_at: null,
        is_master: false,
        workspace_id: WS,
      },
    ],
  });
}

test("minted loyalty coupon resolves for its owner", async () => {
  const resolved = await resolveCoupon(WS, CODE, OWNER, seed());
  assert.ok(resolved, "owner should resolve the coupon");
  assert.equal(resolved!.code, CODE);
  assert.equal(resolved!.type, "fixed_amount");
  assert.equal(resolved!.value, 1500);
  assert.equal(resolved!.source, "internal");
});

test("minted loyalty coupon does NOT resolve for another customer", async () => {
  const resolved = await resolveCoupon(WS, CODE, STRANGER, seed());
  assert.equal(resolved, null, "a stranger must not resolve another customer's coupon");
});

test("minted loyalty coupon does NOT resolve with no customer supplied", async () => {
  const resolved = await resolveCoupon(WS, CODE, null, seed());
  assert.equal(resolved, null, "a customer-scoped coupon must not resolve anonymously");
});

test("resolution is case-insensitive on the code for the owner", async () => {
  const resolved = await resolveCoupon(WS, CODE.toLowerCase(), OWNER, seed());
  assert.ok(resolved, "lower-cased code should still resolve for the owner");
  assert.equal(resolved!.code, CODE);
});
