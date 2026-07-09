/**
 * Phase 2 verification for
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Pins the four Phase 2 § Verification predicates:
 *
 *   1. A crisis-swap-rejected order NOT yet shipped triggers exactly ONE
 *      founder SMS naming the order number, sent to the resolved founder phone.
 *   2. An order already `Shipped` in Amplifier triggers NO cancel SMS (the
 *      caller routes to the return/refund-on-receipt path).
 *   3. The same order does NOT generate duplicate cancel texts on a re-run
 *      (the durable `customer_events` idempotency ledger short-circuits).
 *   4. Missing founder phone / twilio config is a silent no-op — never a throw.
 *
 * We stub `@/lib/twilio` (`sendSMS`) and `@/lib/god-mode` (`resolveFounderPhone`)
 * through Node's module cache before dynamic-importing the SUT — same pattern
 * `refund.guard.test.ts` uses. The Supabase admin is a tiny in-memory shim that
 * models the two tables the emitter touches: `orders` (single-row lookup) and
 * `customer_events` (idempotency read + successful-send stamp).
 *
 * Run:
 *   npx tsx --test src/lib/commerce/founder-cancel-sms.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── World state the stubs mutate ─────────────────────────────────────────
interface OrderRow {
  id: string;
  workspace_id: string;
  order_number: string | null;
  amplifier_status: string | null;
}
interface EventRow {
  workspace_id: string;
  customer_id: string | null;
  event_type: string;
  source: string;
  summary: string | null;
  properties: Record<string, unknown>;
}
interface SmsCall {
  workspaceId: string;
  to: string;
  body: string;
}

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_NOT_SHIPPED = "22222222-2222-2222-2222-222222222222";
const ORDER_ALREADY_SHIPPED = "33333333-3333-3333-3333-333333333333";
const ORDER_NO_AMPLIFIER = "44444444-4444-4444-4444-444444444444";
const FOUNDER_PHONE = "+15550001111";

const orders: OrderRow[] = [];
const events: EventRow[] = [];
const smsSent: SmsCall[] = [];
let sendSmsResult: { success: boolean; messageSid?: string; error?: string } = {
  success: true,
  messageSid: "SM-test-1",
};
let founderPhone: string | null = FOUNDER_PHONE;

function resetWorld(): void {
  orders.length = 0;
  events.length = 0;
  smsSent.length = 0;
  sendSmsResult = { success: true, messageSid: "SM-test-1" };
  founderPhone = FOUNDER_PHONE;
  orders.push(
    { id: ORDER_NOT_SHIPPED, workspace_id: WORKSPACE_ID, order_number: "1001", amplifier_status: "Processing Shipment" },
    { id: ORDER_ALREADY_SHIPPED, workspace_id: WORKSPACE_ID, order_number: "1002", amplifier_status: "Shipped" },
    { id: ORDER_NO_AMPLIFIER, workspace_id: WORKSPACE_ID, order_number: "1003", amplifier_status: null },
  );
}

// ── Supabase stub — two tables the emitter touches ──────────────────────
type Filter = { col: string; val: unknown };
type JsonbFilter = { path: string; op: string; val: unknown };

function makeFrom(table: string) {
  const filters: Filter[] = [];
  const jsonbFilters: JsonbFilter[] = [];
  let pendingInsert: unknown = null;

  const builder = {
    select(_cols: string) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push({ col, val });
      return builder;
    },
    filter(path: string, op: string, val: unknown) {
      jsonbFilters.push({ path, op, val });
      return builder;
    },
    limit(_n: number) {
      return builder;
    },
    async maybeSingle() {
      if (table === "orders") {
        const id = filters.find((f) => f.col === "id")?.val as string | undefined;
        const wsId = filters.find((f) => f.col === "workspace_id")?.val as string | undefined;
        const hit = orders.find((o) => o.id === id && o.workspace_id === wsId);
        return { data: hit ?? null, error: null };
      }
      if (table === "customer_events") {
        const wsId = filters.find((f) => f.col === "workspace_id")?.val as string | undefined;
        const evType = filters.find((f) => f.col === "event_type")?.val as string | undefined;
        const orderIdFilter = jsonbFilters.find(
          (f) => f.path === "properties->>order_id" && f.op === "eq",
        )?.val as string | undefined;
        const hit = events.find(
          (e) =>
            e.workspace_id === wsId &&
            e.event_type === evType &&
            (orderIdFilter === undefined || (e.properties.order_id as string | undefined) === orderIdFilter),
        );
        return { data: hit ? { id: "evt-1" } : null, error: null };
      }
      return { data: null, error: null };
    },
    insert(row: unknown) {
      pendingInsert = row;
      if (table === "customer_events") {
        events.push(row as EventRow);
      }
      // Match Supabase's PostgrestBuilder — resolvable directly (no .select() needed).
      return Promise.resolve({ data: pendingInsert, error: null });
    },
  };
  return builder;
}

const stubAdmin = { from: (table: string) => makeFrom(table) };

// ── Wire module stubs BEFORE importing the SUT ──────────────────────────
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };

moduleAny._cache[require.resolve("@/lib/twilio")] = {
  exports: {
    sendSMS: async (workspaceId: string, to: string, body: string) => {
      smsSent.push({ workspaceId, to, body });
      return sendSmsResult;
    },
  },
};
moduleAny._cache[require.resolve("@/lib/god-mode")] = {
  exports: {
    resolveFounderPhone: async () => founderPhone,
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  sendFounderCancelAmplifierSMS,
  isAmplifierOrderShipped,
  FOUNDER_CANCEL_AMPLIFIER_EVENT,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("@/lib/commerce/founder-cancel-sms") as typeof import("./founder-cancel-sms");

// ── Tests ────────────────────────────────────────────────────────────────

test("Phase-2 Verification #1: not-shipped order → exactly ONE founder SMS naming the order number", async () => {
  resetWorld();
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(r.sent, true);
  assert.equal(r.order_number, "1001");
  assert.equal(smsSent.length, 1, "one and only one SMS");
  assert.equal(smsSent[0].to, FOUNDER_PHONE, "delivered to the resolved founder phone");
  assert.match(smsSent[0].body, /cancel order 1001 in Amplifier/, "body cites the order number");
  assert.equal(events.length, 1, "one ledger row stamped");
  assert.equal(events[0].event_type, FOUNDER_CANCEL_AMPLIFIER_EVENT);
  assert.equal(events[0].properties.order_id, ORDER_NOT_SHIPPED);
});

test("Phase-2 Verification #1 (variant): amplifier_order_id null / amplifier_status null → SMS still fires", async () => {
  resetWorld();
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NO_AMPLIFIER,
  });
  assert.equal(r.sent, true, "order not yet imported to Amplifier is still stoppable");
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /cancel order 1003/);
});

test("Phase-2 Verification #2: order already Shipped → NO cancel SMS", async () => {
  resetWorld();
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ALREADY_SHIPPED,
  });
  assert.equal(r.sent, false);
  assert.match(r.reason ?? "", /Shipped/i);
  assert.equal(smsSent.length, 0, "no SMS on Shipped");
  assert.equal(events.length, 0, "no ledger row on skip");
});

test("Phase-2 Verification #3: re-run for the same order does NOT double-text", async () => {
  resetWorld();
  const first = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(first.sent, true);
  assert.equal(smsSent.length, 1);
  assert.equal(events.length, 1);

  const second = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(second.sent, false, "second call short-circuits on the ledger row");
  assert.match(second.reason ?? "", /already sent/i);
  assert.equal(smsSent.length, 1, "still exactly one SMS after re-run");
  assert.equal(events.length, 1, "still exactly one ledger row");
});

test("Phase-2 Verification #4a: missing founder phone → silent no-op, never throws", async () => {
  resetWorld();
  founderPhone = null;
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(r.sent, false);
  assert.match(r.reason ?? "", /no founder phone/i);
  assert.equal(smsSent.length, 0);
  assert.equal(events.length, 0);
});

test("Phase-2 Verification #4b: twilio not configured (sendSMS success=false) → silent no-op, never throws", async () => {
  resetWorld();
  sendSmsResult = { success: false, error: "Twilio credentials not configured" };
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(r.sent, false);
  assert.match(r.reason ?? "", /Twilio credentials not configured/i);
  assert.equal(smsSent.length, 1, "one send attempt, but no ledger stamp");
  assert.equal(events.length, 0, "no ledger row on transient failure — next attempt retries");
});

test("Phase-2 Verification #4c: transient failure leaves no ledger row → next attempt DOES retry", async () => {
  resetWorld();
  sendSmsResult = { success: false, error: "network error" };
  const first = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(first.sent, false);
  assert.equal(events.length, 0);

  sendSmsResult = { success: true, messageSid: "SM-retry-ok" };
  const second = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_NOT_SHIPPED,
  });
  assert.equal(second.sent, true, "retry succeeds because no ledger row was stamped on the first failure");
  assert.equal(smsSent.length, 2, "two send attempts total");
  assert.equal(events.length, 1, "only the successful attempt stamps the ledger");
});

test("unknown order id → silent no-op, never throws", async () => {
  resetWorld();
  const r = await sendFounderCancelAmplifierSMS(stubAdmin as never, {
    workspaceId: WORKSPACE_ID,
    orderId: "99999999-9999-9999-9999-999999999999",
  });
  assert.equal(r.sent, false);
  assert.match(r.reason ?? "", /not found/i);
  assert.equal(smsSent.length, 0);
});

test("missing required args → silent no-op", async () => {
  resetWorld();
  const r1 = await sendFounderCancelAmplifierSMS(stubAdmin as never, { workspaceId: "", orderId: ORDER_NOT_SHIPPED });
  assert.equal(r1.sent, false);
  const r2 = await sendFounderCancelAmplifierSMS(stubAdmin as never, { workspaceId: WORKSPACE_ID, orderId: "" });
  assert.equal(r2.sent, false);
  assert.equal(smsSent.length, 0);
});

test("isAmplifierOrderShipped: only 'Shipped' returns true", () => {
  assert.equal(isAmplifierOrderShipped("Shipped"), true);
  assert.equal(isAmplifierOrderShipped("  Shipped  "), true, "whitespace-tolerant");
  assert.equal(isAmplifierOrderShipped("Processing Shipment"), false);
  assert.equal(isAmplifierOrderShipped(null), false);
  assert.equal(isAmplifierOrderShipped(""), false);
  assert.equal(isAmplifierOrderShipped(undefined), false);
});
