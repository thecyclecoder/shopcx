/**
 * Regression tests for `getOrderRemedyState` — Phase 1 of the
 * "remedy state must see out-of-band refunds" spec.
 *
 * The failing state we pin, derived from ticket dac9f0c7 (yvette jong, 2026-08-24):
 * SC126000 has a $65.28 order total. Only a $5.32 refund is mirrored into
 * `public.order_refunds`, but Shopify itself has $65.28 already refunded — a
 * $59.96 out-of-band refund was settled directly in the Shopify admin on
 * 2026-04-22. The mirror-only reader reports remaining_refundable_cents = 5996
 * ($59.96) and would authorize a double refund. The live-ledger reader must
 * report remaining_refundable_cents = 0 and surface `out_of_band_refunds_cents`
 * so the CS director sees WHY headroom is lower than the mirror implies.
 *
 * Run: npx tsx --test src/lib/cx-agent-sdk.remedyState.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { getOrderRemedyState } from "./cx-agent-sdk";
import type { OrderRefundLedger } from "./refund-ledger";

interface Row {
  [k: string]: unknown;
}

interface FakeState {
  orders: Row[];
  order_refunds: Row[];
  returns: Row[];
}

function makeAdmin(state: FakeState) {
  function makeBuilder(rows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    const b = {
      select(_cols: string) {
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, asc: opts?.ascending ?? true };
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderBy) {
          const { col, asc } = orderBy;
          out = [...out].sort((a, x) => {
            const av = a[col] as string;
            const bv = x[col] as string;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        if (limitN != null) out = out.slice(0, limitN);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return b;
  }
  return {
    from(table: string) {
      const rows = (state as unknown as Record<string, Row[] | undefined>)[table] ?? [];
      return makeBuilder(rows);
    },
  } as unknown as Parameters<typeof getOrderRemedyState>[0];
}

const WS = "00000000-0000-0000-0000-0000000000ws";
const ORDER_ID = "11111111-1111-1111-1111-1111111111ff";

/** SC126000 shape: $65.28 total, one $5.32 mirrored refund, $59.96 out-of-band on Shopify. */
function sc126000State(): FakeState {
  return {
    orders: [
      {
        id: ORDER_ID,
        workspace_id: WS,
        order_number: "SC126000",
        shopify_order_id: "shopify-sc126000",
        total_cents: 6528,
        financial_status: "refunded",
      },
    ],
    order_refunds: [
      {
        id: "ref-mirror-1",
        workspace_id: WS,
        order_id: ORDER_ID,
        vendor: "shopify",
        vendor_refund_id: "shopify-ref-mirror",
        amount_cents: 532,
        status: "succeeded",
        requested_at: "2026-04-01T00:00:00Z",
      },
    ],
    returns: [],
  };
}

test("getOrderRemedyState surfaces the out-of-band Shopify refund via the live ledger (SC126000)", async () => {
  const admin = makeAdmin(sc126000State());
  const liveLedger: OrderRefundLedger = {
    ok: true,
    saleCents: 6528,
    refundedCents: 6528, // $5.32 mirrored + $59.96 out-of-band
    pendingCents: 0,
    refundableCents: 0, // whole order already refunded on Shopify
    outOfBandCents: 5996,
    refunds: [],
  };

  const state = await getOrderRemedyState(
    admin,
    WS,
    { orderNumber: "SC126000" },
    { getLedger: async () => liveLedger },
  );

  assert.equal(state.found, true);
  assert.equal(state.total_cents, 6528);
  // The whole point of the fix: refunded_so_far must reflect the LEDGER, not just the mirror.
  assert.equal(state.refunds_succeeded_cents, 6528);
  // Remaining refundable is 0 — a fresh refund would double-pay a fully-refunded order.
  assert.equal(state.remaining_refundable_cents, 0);
  // The out-of-band field explains WHY the mirror-only math is wrong.
  assert.equal(state.out_of_band_refunds_cents, 5996);
  // The live-ledger read is trustable; a money guard can act on the ceiling.
  assert.equal(state.headroom_confidence, "live");
  // Mirror rows are still surfaced for provenance (which refund WE issued).
  assert.equal(state.succeeded_refunds.length, 1);
  assert.equal(state.succeeded_refunds[0].amount_cents, 532);
});

test("getOrderRemedyState marks headroom_confidence=degraded on ledger failure and does NOT silently trust the mirror", async () => {
  const admin = makeAdmin(sc126000State());
  const failedLedger: OrderRefundLedger = {
    ok: false,
    reason: "shopify_call_failed",
    error: "Shopify transactions.json 500: down",
  };

  const state = await getOrderRemedyState(
    admin,
    WS,
    { orderNumber: "SC126000" },
    { getLedger: async () => failedLedger },
  );

  assert.equal(state.found, true);
  // Fallback numbers come from the mirror (the caller can still see them), but the marker MUST
  // be 'degraded' so a downstream refund guard refuses rather than trusts the (potentially
  // overstated) headroom.
  assert.equal(state.refunds_succeeded_cents, 532);
  assert.equal(state.remaining_refundable_cents, 5996);
  // We don't invent an out-of-band figure we couldn't read.
  assert.equal(state.out_of_band_refunds_cents, 0);
  assert.equal(state.headroom_confidence, "degraded");
});

test("getOrderRemedyState on a resolvable-but-non-Shopify order reports headroom_confidence=degraded", async () => {
  const state = await getOrderRemedyState(
    makeAdmin(sc126000State()),
    WS,
    { orderNumber: "SC126000" },
    {
      getLedger: async () => ({ ok: false, reason: "no_shopify_order_id" }),
    },
  );
  assert.equal(state.found, true);
  assert.equal(state.headroom_confidence, "degraded");
});

test("getOrderRemedyState empty (order not found) returns degraded confidence, not a trustable zero", async () => {
  const state = await getOrderRemedyState(
    makeAdmin({ orders: [], order_refunds: [], returns: [] }),
    WS,
    { orderNumber: "DOES-NOT-EXIST" },
  );
  assert.equal(state.found, false);
  assert.equal(state.remaining_refundable_cents, 0);
  // A caller cannot mistake the empty state for a "clean" (zero-balance) trustable read.
  assert.equal(state.headroom_confidence, "degraded");
});
