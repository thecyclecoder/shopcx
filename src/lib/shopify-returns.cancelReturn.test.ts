/**
 * Pins the two invariants the returns-cancel-return-chokepoint spec adds to
 * src/lib/shopify-returns.ts:
 *
 *  1. cancelReturn's COMPARE-AND-SET — the status flip to 'cancelled' fires
 *     ONLY when the UPDATE actually transitioned a row (the `.in('status',
 *     CANCELLABLE_RETURN_STATUSES)` filter matched). Zero rows transitioned
 *     (terminal/already-cancelled status) → success:false, no Shopify/EasyPost
 *     cleanup, no customer_event.
 *
 *  2. processReturn's DOUBLE-PAY guard — when the live refund ledger shows the
 *     order is already fully refunded (refundableCents == 0, refundedCents > 0)
 *     processReturn refuses, escalates to dashboard_notifications, and never
 *     reaches Shopify. With headroom remaining the guard is a no-op and the
 *     flow proceeds to the Shopify processing path.
 *
 * Same ESM-cache stubbing pattern as shopify-returns.closeReturn.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/shopify-returns.cancelReturn.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── Mutable world the stubs read ────────────────────────────────────────
type AnyRow = Record<string, unknown> | null;

let returnsReadRow: AnyRow = null; // row returned by from('returns').select…maybeSingle/single
let casRows: Array<{ id: string }> = []; // rows the CAS .select('id') returns
let casError: { message: string } | null = null;
let ledger: unknown = { ok: false, reason: "order_not_found" };
let shopifyCredentialsCalls = 0;
let fetchCalls = 0;
const inserts: Record<string, Array<Record<string, unknown>>> = {};

function resetWorld(): void {
  returnsReadRow = null;
  casRows = [];
  casError = null;
  ledger = { ok: false, reason: "order_not_found" };
  shopifyCredentialsCalls = 0;
  fetchCalls = 0;
  for (const k of Object.keys(inserts)) delete inserts[k];
}

// ── Chainable + thenable Supabase stub ──────────────────────────────────
function makeFrom(table: string) {
  let mode: "read" | "update" | "insert" = "read";
  const builder: Record<string, unknown> = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    in() {
      return builder;
    },
    update() {
      mode = "update";
      return builder;
    },
    insert(row: Record<string, unknown>) {
      mode = "insert";
      (inserts[table] ||= []).push(row);
      return builder;
    },
    async single() {
      return { data: returnsReadRow, error: null };
    },
    async maybeSingle() {
      return { data: returnsReadRow, error: null };
    },
    // Thenable: an awaited chain resolves based on the operation performed.
    then(resolve: (v: unknown) => void) {
      if (mode === "update") return resolve({ data: casRows, error: casError });
      return resolve({ data: null, error: null });
    },
  };
  return builder;
}

const stubAdmin = { from: (table: string) => makeFrom(table) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/refund-ledger")] = {
  exports: { getOrderRefundLedger: async () => ledger },
};
moduleAny._cache[require.resolve("@/lib/shopify-sync")] = {
  exports: {
    getShopifyCredentials: async () => {
      shopifyCredentialsCalls += 1;
      return { shop: "test.myshopify.com", accessToken: "stub" };
    },
  },
};

const originalFetch = global.fetch;
global.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("fetch should not be reached in these tests");
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require("./shopify-returns") as typeof import("./shopify-returns");
const { cancelReturn, processReturn, CANCELLABLE_RETURN_STATUSES } = mod;

const WS = "ws-1";
const RID = "ret-1";

// ── cancelReturn: compare-and-set ───────────────────────────────────────

test("CANCELLABLE_RETURN_STATUSES is exactly the non-terminal set", () => {
  assert.deepEqual([...CANCELLABLE_RETURN_STATUSES], ["open", "label_created", "in_transit"]);
});

test("cancelReturn: missing row → Return not found, no mutation", async () => {
  resetWorld();
  returnsReadRow = null;
  const r = await cancelReturn(WS, RID, "customer mailed box back");
  assert.equal(r.success, false);
  assert.equal(r.error, "Return not found");
});

test("cancelReturn: CAS matched one row → success, customer_event logged", async () => {
  resetWorld();
  // open internal return (no shopify gid, no easypost label) so no external I/O
  returnsReadRow = {
    id: RID,
    status: "label_created",
    order_number: "SC140786",
    customer_id: "cust-1",
    shopify_return_gid: null,
    easypost_shipment_id: null,
  };
  casRows = [{ id: RID }]; // the UPDATE transitioned exactly one row

  const r = await cancelReturn(WS, RID, "order already refunded — avoid double-pay");

  assert.equal(r.success, true);
  assert.equal(r.error, undefined);
  assert.equal(shopifyCredentialsCalls, 0, "internal return must not hit Shopify");
  assert.equal(fetchCalls, 0, "no label → no EasyPost void");
  const events = inserts["customer_events"] || [];
  assert.equal(events.length, 1, "exactly one audit customer_event");
  assert.equal(events[0].event_type, "return_cancelled");
});

test("cancelReturn: CAS matched zero rows (terminal status) → refused, no side effects", async () => {
  resetWorld();
  returnsReadRow = {
    id: RID,
    status: "refunded", // terminal — not in CANCELLABLE_RETURN_STATUSES
    order_number: "SC140786",
    customer_id: "cust-1",
    shopify_return_gid: null,
    easypost_shipment_id: null,
  };
  casRows = []; // the `.in('status', …)` filter matched nothing

  const r = await cancelReturn(WS, RID, "too late");

  assert.equal(r.success, false);
  assert.match(r.error || "", /not in a cancellable state/);
  assert.match(r.error || "", /refunded/);
  assert.equal((inserts["customer_events"] || []).length, 0, "refused cancel writes no audit event");
});

// ── processReturn: double-pay guard ─────────────────────────────────────

test("processReturn: order fully refunded → refuse + escalate, no Shopify call", async () => {
  resetWorld();
  returnsReadRow = {
    shopify_return_gid: "gid://shopify/Return/1",
    return_line_items: [],
    order_id: "ord-1",
    order_number: "SC140786",
  };
  // Live ledger: $99.66 refunded, $0 refundable — the Lori Hall shape.
  ledger = { ok: true, saleCents: 9966, refundedCents: 9966, pendingCents: 0, refundableCents: 0, outOfBandCents: 0, refunds: [] };

  const r = await processReturn(WS, RID);

  assert.equal(r.success, false);
  assert.match(r.error || "", /already fully refunded/);
  assert.equal(shopifyCredentialsCalls, 0, "must refuse BEFORE any Shopify processing");
  assert.equal(fetchCalls, 0);
  const notes = inserts["dashboard_notifications"] || [];
  assert.equal(notes.length, 1, "escalates exactly one founder notification");
  assert.equal((notes[0].metadata as Record<string, unknown>).type, "return_process_double_pay_refused");
});

test("processReturn: headroom remaining → guard is a no-op, proceeds to Shopify", async () => {
  resetWorld();
  returnsReadRow = {
    shopify_return_gid: "gid://shopify/Return/1",
    return_line_items: [],
    order_id: "ord-1",
    order_number: "SC150000",
  };
  // Nothing refunded yet — full headroom.
  ledger = { ok: true, saleCents: 9966, refundedCents: 0, pendingCents: 0, refundableCents: 9966, outOfBandCents: 0, refunds: [] };

  const r = await processReturn(WS, RID);

  // The guard did NOT fire, so execution reaches the Shopify path — where our
  // stubbed getShopifyCredentials is called and the stubbed fetch then throws,
  // caught into a generic failure. The point: no double-pay refusal/escalation.
  assert.equal(r.success, false, "stubbed Shopify fetch throws — expected");
  assert.equal(shopifyCredentialsCalls, 1, "guard passed → reached Shopify credentials");
  assert.equal((inserts["dashboard_notifications"] || []).length, 0, "no double-pay escalation when headroom remains");
});

// ── Restore ─────────────────────────────────────────────────────────────

test("teardown: restore global.fetch", () => {
  global.fetch = originalFetch;
});
