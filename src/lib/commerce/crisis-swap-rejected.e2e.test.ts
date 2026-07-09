/**
 * Phase 4 end-to-end verification for
 * [[../../../docs/brain/specs/sol-crisis-swap-rejected-full-refund-and-sms-founder-to-cancel-amplifier-order]].
 *
 * Pins the FOUR § Phase 4 Verification scenarios end-to-end through the real
 * Phase-1 classifier + Phase-2 founder-cancel-SMS emitter + Phase-3 sequencer.
 * Only `issueRefund` (money movement) + `hashActionRefundKey` are stubbed at
 * the sequencer's dep boundary; the Phase-2 emitter runs against the same
 * stub Supabase admin the sequencer's loadOrder / sumPriorRefunds do, and
 * `resolveFounderPhone` + `sendSMS` are module-cache-stubbed so the emitter's
 * REAL Shipped-guard + idempotency ledger + resolveFounderPhone-null branch
 * all fire for real.
 *
 * Scenarios (spec § Phase 4 Verification):
 *   1. crisis-swap-rejected + NOT shipped
 *      → full remaining-balance refund
 *      → exactly ONE founder SMS naming the order number
 *   2. already Shipped in Amplifier
 *      → NO founder cancel SMS (return path)
 *      → refund STILL proceeds (a Shipped order still owes the customer;
 *        return-on-receipt runs in parallel — the internal note is honest
 *        about the disposition)
 *   3. swap accepted / different in-stock flavor
 *      → NO full refund, NO founder SMS (classifier short-circuit)
 *   4. prior partial refund respected (Cheri: $116.41 total, $26.89 prior
 *      → refund $89.52 remainder, NOT the full $116.41)
 *
 * Run:
 *   npx tsx --test src/lib/commerce/crisis-swap-rejected.e2e.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── World state the stub tables + twilio stub mutate ────────────────────
interface OrderRow {
  id: string;
  workspace_id: string;
  order_number: string | null;
  total_cents: number;
  amplifier_status: string | null;
  line_items: Array<{ variant_id: string; title: string }>;
}
interface EventRow {
  workspace_id: string;
  customer_id: string | null;
  event_type: string;
  source: string;
  summary: string | null;
  properties: Record<string, unknown>;
}
interface RefundRow {
  workspace_id: string;
  order_id: string;
  amount_cents: number;
  status: "succeeded" | "settled" | "requested" | "failed" | "reversed";
}
interface SmsCall {
  workspaceId: string;
  to: string;
  body: string;
}

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const FOUNDER_PHONE = "+15550001111";

const orders: OrderRow[] = [];
const events: EventRow[] = [];
const refundLedger: RefundRow[] = [];
const smsSent: SmsCall[] = [];
let founderPhone: string | null = FOUNDER_PHONE;

function resetWorld(): void {
  orders.length = 0;
  events.length = 0;
  refundLedger.length = 0;
  smsSent.length = 0;
  founderPhone = FOUNDER_PHONE;
}

// ── Supabase stub — enough of the `orders` + `customer_events` shape for
//    the Phase-2 emitter (single-row order lookup + jsonb idempotency read +
//    ledger insert) ────────────────────────────────────────────────────
type Filter = { col: string; val: unknown };
type JsonbFilter = { path: string; op: string; val: unknown };

function makeFrom(table: string) {
  const filters: Filter[] = [];
  const jsonbFilters: JsonbFilter[] = [];

  const builder = {
    select(_cols: string) {
      return builder;
    },
    eq(col: string, val: unknown) {
      filters.push({ col, val });
      return builder;
    },
    in(_col: string, _vals: unknown[]) {
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
      if (table === "customer_events") {
        events.push(row as EventRow);
      }
      return Promise.resolve({ data: row, error: null });
    },
  };
  return builder;
}

const stubAdmin = { from: (table: string) => makeFrom(table) };

// ── Module-cache stubs for the Phase-2 emitter's dependencies ────────────
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/twilio")] = {
  exports: {
    sendSMS: async (workspaceId: string, to: string, body: string) => {
      smsSent.push({ workspaceId, to, body });
      return { success: true, messageSid: `SM-e2e-${smsSent.length}` };
    },
  },
};
moduleAny._cache[require.resolve("@/lib/god-mode")] = {
  exports: {
    resolveFounderPhone: async () => founderPhone,
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { executeCrisisSwapRejectedRemedy } = require(
  "@/lib/commerce/crisis-swap-rejected-sequencer",
) as typeof import("./crisis-swap-rejected-sequencer");

// ── Test doubles for the sequencer's non-Phase-2 deps ────────────────────
//
// - loadOrder + sumPriorRefunds read the same stub world the Phase-2 emitter
//   reads through (so a Shipped order is Shipped for both).
// - issueRefund records a ledger row + returns success.
// - hashActionRefundKey is a stable string over (scope, actor, order, amount, reason).
function makeStubDeps() {
  const refundCalls: Array<{ workspaceId: string; args: Record<string, unknown> }> = [];
  return {
    refundCalls,
    deps: {
      loadOrder: async (_admin: unknown, workspaceId: string, orderId: string) => {
        const hit = orders.find((o) => o.id === orderId && o.workspace_id === workspaceId);
        return hit ?? null;
      },
      sumPriorRefunds: async (_admin: unknown, workspaceId: string, orderId: string) => {
        return refundLedger
          .filter(
            (r) =>
              r.workspace_id === workspaceId &&
              r.order_id === orderId &&
              (r.status === "succeeded" || r.status === "settled"),
          )
          .reduce((s, r) => s + r.amount_cents, 0);
      },
      issueRefund: async (workspaceId: string, args: {
        orderId: string;
        amountCents: number;
        reason: string;
      }) => {
        refundCalls.push({ workspaceId, args });
        refundLedger.push({
          workspace_id: workspaceId,
          order_id: args.orderId,
          amount_cents: args.amountCents,
          status: "succeeded",
        });
        return { success: true, method: "braintree" as const, refund_id: `bt-${refundCalls.length}` };
      },
      hashActionRefundKey: (scope: string, id: string, orderId: string, amount: number, reason: string) => {
        return `k:${scope}:${id}:${orderId}:${amount}:${reason.slice(0, 8)}`;
      },
    },
  };
}

const ACTIVE_CRISIS = {
  id: "crisis-berry",
  status: "active",
  affected_variant_id: "variant-mixed-berry",
  default_swap_variant_id: "variant-tropical-swap",
  affected_product_title: "Mixed Berry",
  expected_restock_date: "2026-09-01",
} as const;

// ── The four Phase-4 verification scenarios ─────────────────────────────

test("E2E #1: crisis-swap-rejected + NOT shipped → full remaining-balance refund + exactly ONE founder SMS naming the order number", async () => {
  resetWorld();
  orders.push({
    id: "ord-1",
    workspace_id: WORKSPACE_ID,
    order_number: "1001",
    total_cents: 11641,
    amplifier_status: "Processing Shipment",
    line_items: [{ variant_id: "variant-tropical-swap", title: "Tropical (swap)" }],
  });
  const { deps, refundCalls } = makeStubDeps();

  const r = await executeCrisisSwapRejectedRemedy(
    stubAdmin as never,
    {
      workspaceId: WORKSPACE_ID,
      orderId: "ord-1",
      ticketId: "ticket-1",
      customerId: "cust-1",
      customerMessageText: "I only want mixed berry — no substitutions please. I'll wait.",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund.fired, true);
  assert.equal(r.refund.success, true);
  assert.equal(r.refund.amount_cents, 11641, "full remaining balance (no prior refunds)");
  assert.equal(refundCalls.length, 1, "issueRefund called exactly once");
  assert.equal(smsSent.length, 1, "exactly one founder SMS");
  assert.equal(smsSent[0].to, FOUNDER_PHONE, "delivered to the resolved founder phone");
  assert.match(smsSent[0].body, /cancel order 1001 in Amplifier/, "body cites the order number");
  assert.match(r.internal_note, /full refund \$116\.41 \+ founder texted to cancel 1001/);
});

test("E2E #2: already Shipped in Amplifier → NO founder cancel SMS (return path); refund STILL proceeds (return-on-receipt in parallel)", async () => {
  resetWorld();
  orders.push({
    id: "ord-2",
    workspace_id: WORKSPACE_ID,
    order_number: "1002",
    total_cents: 11641,
    amplifier_status: "Shipped",
    line_items: [{ variant_id: "variant-tropical-swap", title: "Tropical (swap)" }],
  });
  const { deps, refundCalls } = makeStubDeps();

  const r = await executeCrisisSwapRejectedRemedy(
    stubAdmin as never,
    {
      workspaceId: WORKSPACE_ID,
      orderId: "ord-2",
      ticketId: "ticket-2",
      customerId: "cust-2",
      customerMessageText: "berry only, I'll wait until it's back",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(smsSent.length, 0, "NO founder SMS when order is already Shipped");
  assert.equal(r.sms.sent, false);
  assert.match(r.sms.reason ?? "", /Shipped/i);
  assert.equal(r.refund.fired, true, "refund still proceeds — a Shipped order is still owed");
  assert.equal(r.refund.success, true);
  assert.equal(refundCalls.length, 1);
  assert.match(r.internal_note, /already Shipped in Amplifier — return path/);
  assert.match(r.internal_note, /full refund \$116\.41/);
});

test("E2E #3: swap accepted → NO full refund, NO founder SMS (classifier short-circuits)", async () => {
  resetWorld();
  orders.push({
    id: "ord-3",
    workspace_id: WORKSPACE_ID,
    order_number: "1003",
    total_cents: 11641,
    amplifier_status: "Processing Shipment",
    line_items: [{ variant_id: "variant-tropical-swap", title: "Tropical (swap)" }],
  });
  const { deps, refundCalls } = makeStubDeps();

  const r = await executeCrisisSwapRejectedRemedy(
    stubAdmin as never,
    {
      workspaceId: WORKSPACE_ID,
      orderId: "ord-3",
      ticketId: "ticket-3",
      customerId: "cust-3",
      customerMessageText: "the swap is fine, thanks for letting me know",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  assert.equal(r.classification, "swap_accepted");
  assert.equal(r.refund.fired, false, "NO full refund on an accepted swap");
  assert.equal(refundCalls.length, 0);
  assert.equal(smsSent.length, 0, "NO founder SMS on an accepted swap");
  assert.match(r.internal_note, /skipped \(swap_accepted\)/);
  assert.equal(r.customer_reply_draft, "", "no draft on skip — caller composes the accepted-swap reply itself");
});

test("E2E #4 (Cheri case): prior partial refund respected — refunds the REMAINDER, not the full total", async () => {
  resetWorld();
  orders.push({
    id: "ord-4",
    workspace_id: WORKSPACE_ID,
    order_number: "1099",
    total_cents: 11641, // $116.41
    amplifier_status: "Processing Shipment",
    line_items: [{ variant_id: "variant-tropical-swap", title: "Tropical (swap)" }],
  });
  // Prior partial: $26.89 already refunded (a price-correction from an earlier turn).
  refundLedger.push({
    workspace_id: WORKSPACE_ID,
    order_id: "ord-4",
    amount_cents: 2689,
    status: "succeeded",
  });
  const { deps, refundCalls } = makeStubDeps();

  const r = await executeCrisisSwapRejectedRemedy(
    stubAdmin as never,
    {
      workspaceId: WORKSPACE_ID,
      orderId: "ord-4",
      ticketId: "ticket-4",
      customerId: "cust-4",
      customerMessageText: "berry only please, no substitutes — I'll wait",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );

  assert.equal(r.classification, "crisis_swap_rejected");
  assert.equal(r.refund.fired, true);
  assert.equal(r.refund.success, true);
  assert.equal(
    r.refund.amount_cents,
    11641 - 2689,
    "refund the $89.52 remainder, NOT the full $116.41",
  );
  assert.equal(r.refund.prior_refunded_cents, 2689);
  assert.equal(r.refund.order_total_cents, 11641);
  assert.equal(refundCalls.length, 1, "issueRefund called exactly once");
  assert.equal(refundCalls[0].args.amountCents, 11641 - 2689);
  // The full-refund path can NEVER over-refund an order:
  const totalAfter = refundLedger
    .filter((r) => r.order_id === "ord-4" && (r.status === "succeeded" || r.status === "settled"))
    .reduce((s, r) => s + r.amount_cents, 0);
  assert.ok(totalAfter <= 11641, `sum of refunds (${totalAfter}) must never exceed order total (11641)`);
  assert.match(r.internal_note, /full refund \$89\.52 \+ founder texted to cancel 1099/);
  // Founder SMS still fires exactly once.
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /cancel order 1099 in Amplifier/);
});

test("E2E #4 (bonus): a re-run of the SAME remedy on ord-4 does NOT double-text the founder (Phase-2 ledger short-circuits)", async () => {
  // Continues from the ord-4 world set up above. Do not reset — we're
  // verifying idempotency across two remedy invocations on the same order.
  //
  // The refund ledger already carries the first success; the classifier
  // sees prior_refunded_cents === 11641, clamps the remainder to 0, and
  // the sequencer bails BEFORE the vendor call. The founder-cancel ledger
  // already carries the first SMS, so a re-run doesn't re-text either.
  const smsBefore = smsSent.length;
  const { deps, refundCalls } = makeStubDeps();
  const r = await executeCrisisSwapRejectedRemedy(
    stubAdmin as never,
    {
      workspaceId: WORKSPACE_ID,
      orderId: "ord-4",
      ticketId: "ticket-4",
      customerId: "cust-4",
      customerMessageText: "berry only please, no substitutes — I'll wait",
      crisis: ACTIVE_CRISIS,
    },
    deps,
  );
  assert.equal(r.refund.fired, false, "no second vendor call — remainder is $0 after the first refund");
  assert.equal(refundCalls.length, 0);
  assert.equal(smsSent.length, smsBefore, "no second founder SMS — Phase-2 ledger blocked it");
});
