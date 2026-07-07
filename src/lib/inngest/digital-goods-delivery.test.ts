/**
 * Idempotency + ownership tests for the digital-goods-delivery library.
 * (Phase 2 + Phase 3 of docs/brain/specs/digital-goods-delivery.md.)
 *
 * Pins the invariants each phase's verification names:
 *
 * Phase 2 — deliverDigitalGoodOnce:
 *   - First call for (order, digital_good) sends exactly one Resend email
 *     with the PDF attached AND writes exactly one digital_good_deliveries
 *     ledger row.
 *   - A re-processing call for the same (order, digital_good) sends zero
 *     additional Resend emails — the pre-dispatch guard hits the ledger
 *     row and short-circuits.
 *   - extractDigitalGoodIds ignores lines with no digital_good_id and dedupes
 *     duplicate references.
 *
 * Phase 3 — resendDigitalGoodForOwner:
 *   - Owner (order.customer_id in link group + line_items references good)
 *     → resends, no ledger mutation, Resend called exactly once per call.
 *   - Non-owner: order.customer_id not in link group → not_owned, no send.
 *   - Non-owner: line_items does not reference the good → not_owned, no send.
 *   - Empty ownerCustomerIds → not_owned, no send.
 *   - Non-downloadable good → not_a_downloadable, no send.
 *
 * We stub the Supabase admin client + Resend client through Node's ESM
 * module cache BEFORE dynamic-importing digital-goods-delivery. The stub
 * client models digital_goods, digital_good_deliveries, workspaces, and
 * orders + a `.storage.from(BUCKET).download` that returns a tiny in-memory
 * blob, and counts Resend `.emails.send` calls so the "exactly one" and
 * "zero when not owned" invariants are directly assertable.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/digital-goods-delivery.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ORDER_ID = "22222222-2222-2222-2222-222222222222";
const GOOD_ID = "33333333-3333-3333-3333-333333333333";
const OWNER_CUSTOMER_ID = "44444444-4444-4444-4444-444444444444";
const STRANGER_CUSTOMER_ID = "55555555-5555-5555-5555-555555555555";

interface DeliveryLedgerRow {
  workspace_id: string;
  order_id: string;
  digital_good_id: string;
  resend_email_id: string | null;
  delivered_at: string;
}

interface OrderRow {
  id: string;
  order_number: string | null;
  email: string | null;
  customer_id: string | null;
  line_items: Array<Record<string, unknown>>;
}

const ledger: DeliveryLedgerRow[] = [];
let resendSendCalls: Array<{ to: string; subject: string; attachmentBytes: number }> = [];
let downloadCalls = 0;

const digitalGoodRow = {
  id: GOOD_ID,
  name: "Anti-Inflammatory Recipes",
  type: "downloadable" as const,
  asset_path: "guides/anti-inflammatory-recipes.pdf",
  delivery: "attachment" as const,
};

const coverageGoodRow = {
  id: GOOD_ID,
  name: "Shipping Protection",
  type: "coverage" as const,
  asset_path: null,
  delivery: "none" as const,
};

let goodRowVariant: typeof digitalGoodRow | typeof coverageGoodRow = digitalGoodRow;

const workspaceRow = {
  transactional_from_name: "Superfoods Company",
  name: "Superfoods",
};

// Orders "table" — the test seeds one row per scenario.
const ordersStore = new Map<string, OrderRow>();

function seedOrder(row: OrderRow) {
  ordersStore.set(row.id, row);
}

function resetWorld(): void {
  ledger.length = 0;
  resendSendCalls = [];
  downloadCalls = 0;
  ordersStore.clear();
  goodRowVariant = digitalGoodRow;
}

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  single(): Promise<{ data: unknown; error: null }>;
  insert(row: DeliveryLedgerRow): Promise<{ data: null; error: null | { message: string } }>;
}

function makeFrom(table: string): QueryBuilder {
  const filters: Record<string, unknown> = {};
  const builder: QueryBuilder = {
    select(_cols) {
      return builder;
    },
    eq(col, val) {
      filters[col] = val;
      return builder;
    },
    async maybeSingle() {
      if (table === "digital_good_deliveries") {
        const hit = ledger.find(
          (r) =>
            r.workspace_id === filters.workspace_id &&
            r.order_id === filters.order_id &&
            r.digital_good_id === filters.digital_good_id,
        );
        return { data: hit ?? null, error: null };
      }
      if (table === "digital_goods") {
        if (filters.id === GOOD_ID && filters.workspace_id === WORKSPACE_ID) {
          return { data: goodRowVariant, error: null };
        }
        return { data: null, error: null };
      }
      if (table === "orders") {
        const row = ordersStore.get(String(filters.id));
        if (row) return { data: row, error: null };
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      if (table === "workspaces") return { data: workspaceRow, error: null };
      return { data: null, error: null };
    },
    async insert(row) {
      if (table === "digital_good_deliveries") {
        // Emulate the unique (order_id, digital_good_id) index.
        const clash = ledger.find(
          (r) => r.order_id === row.order_id && r.digital_good_id === row.digital_good_id,
        );
        if (clash) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        ledger.push(row);
      }
      return { data: null, error: null };
    },
  };
  return builder;
}

function makeStubBlob(text: string) {
  return {
    async arrayBuffer() {
      return Buffer.from(text, "utf8").buffer;
    },
  };
}

const stubAdmin = {
  from(table: string) {
    return makeFrom(table);
  },
  storage: {
    from(_bucket: string) {
      return {
        async download(_path: string) {
          downloadCalls++;
          return { data: makeStubBlob("%PDF-1.4 stub"), error: null };
        },
      };
    },
  },
};

const stubResendClient = {
  resend: {
    emails: {
      async send(payload: {
        from: string;
        to: string;
        subject: string;
        html: string;
        attachments?: Array<{ filename: string; content: Buffer }>;
      }) {
        const attachmentBytes = (payload.attachments || []).reduce((s, a) => s + a.content.length, 0);
        resendSendCalls.push({ to: payload.to, subject: payload.subject, attachmentBytes });
        return { data: { id: `resend-${resendSendCalls.length}` }, error: null };
      },
    },
  },
  domain: "updates.superfoods.co",
  supportEmail: null,
};

// Wire the stubs into Node's module cache BEFORE we import digital-goods-delivery.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/email")] = {
  exports: { getResendClient: async () => stubResendClient },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deliverDigitalGoodOnce, extractDigitalGoodIds, resendDigitalGoodForOwner } =
  require("./digital-goods-delivery") as typeof import("./digital-goods-delivery");

// ── Phase 2: idempotent order-created delivery ────────────────────

test("Phase 2: first delivery sends exactly one Resend email with PDF attached and writes exactly one ledger row", async () => {
  resetWorld();
  const res = await deliverDigitalGoodOnce({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    orderNumber: "SC000001",
    customerEmail: "buyer@example.com",
    digitalGoodId: GOOD_ID,
  });
  assert.equal(res.status, "delivered");
  assert.equal(res.resend_email_id, "resend-1");
  assert.equal(resendSendCalls.length, 1, "exactly one Resend email fired");
  assert.equal(resendSendCalls[0].to, "buyer@example.com");
  assert.ok(resendSendCalls[0].subject.includes("Anti-Inflammatory Recipes"), "subject names the good");
  assert.ok(resendSendCalls[0].attachmentBytes > 0, "attachment content is non-empty");
  assert.equal(ledger.length, 1, "exactly one ledger row written");
  assert.equal(ledger[0].resend_email_id, "resend-1");
  assert.equal(downloadCalls, 1, "asset downloaded once");
});

test("Phase 2: re-processing the same (order, digital_good) sends no duplicate — pre-dispatch guard hits ledger", async () => {
  resetWorld();
  const first = await deliverDigitalGoodOnce({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    orderNumber: "SC000001",
    customerEmail: "buyer@example.com",
    digitalGoodId: GOOD_ID,
  });
  assert.equal(first.status, "delivered");
  assert.equal(resendSendCalls.length, 1);
  assert.equal(ledger.length, 1);

  const second = await deliverDigitalGoodOnce({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    orderNumber: "SC000001",
    customerEmail: "buyer@example.com",
    digitalGoodId: GOOD_ID,
  });
  assert.equal(second.status, "skipped_already_delivered");
  assert.equal(second.resend_email_id, "resend-1", "reports the original Resend id");
  assert.equal(resendSendCalls.length, 1, "no duplicate email");
  assert.equal(ledger.length, 1, "no duplicate ledger row");
  assert.equal(downloadCalls, 1, "no duplicate storage download");
});

test("extractDigitalGoodIds returns the distinct set and ignores lines with no digital_good_id", () => {
  const lines = [
    { sku: "SF-BUNDLE", quantity: 1 },
    { digital_good_id: "aaa", quantity: 1 },
    { digital_good_id: "bbb", quantity: 1 },
    { digital_good_id: "aaa", quantity: 1 }, // duplicate — dedupe
    { digital_good_id: 42 }, // non-string — ignore
    { sku: "SF-BOX" },
  ];
  const ids = extractDigitalGoodIds(lines);
  assert.deepEqual(ids.sort(), ["aaa", "bbb"]);
});

test("extractDigitalGoodIds tolerates non-array input", () => {
  assert.deepEqual(extractDigitalGoodIds(null), []);
  assert.deepEqual(extractDigitalGoodIds(undefined), []);
  assert.deepEqual(extractDigitalGoodIds({ line_items: [] }), []);
});

// ── Phase 3: portal-triggered resend with ownership guard ─────────

test("Phase 3: owner (order in link group + line references good) can resend — Resend fires once, ledger untouched", async () => {
  resetWorld();
  seedOrder({
    id: ORDER_ID,
    order_number: "SC000001",
    email: "buyer@example.com",
    customer_id: OWNER_CUSTOMER_ID,
    line_items: [{ digital_good_id: GOOD_ID, quantity: 1 }],
  });

  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [OWNER_CUSTOMER_ID],
    digitalGoodId: GOOD_ID,
  });

  assert.equal(res.status, "sent");
  assert.equal(res.resend_email_id, "resend-1");
  assert.equal(resendSendCalls.length, 1, "exactly one Resend email fired");
  assert.equal(resendSendCalls[0].to, "buyer@example.com");
  assert.ok(resendSendCalls[0].attachmentBytes > 0, "attachment attached");
  // Phase-2 ledger invariant preserved: portal resend does NOT write a row.
  assert.equal(ledger.length, 0, "portal resend leaves the ledger untouched");
});

test("Phase 3: non-owner (order.customer_id not in link group) CANNOT resend — no Resend send", async () => {
  resetWorld();
  seedOrder({
    id: ORDER_ID,
    order_number: "SC000001",
    email: "buyer@example.com",
    customer_id: STRANGER_CUSTOMER_ID, // order belongs to someone else
    line_items: [{ digital_good_id: GOOD_ID, quantity: 1 }],
  });

  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [OWNER_CUSTOMER_ID], // caller is NOT the owner
    digitalGoodId: GOOD_ID,
  });

  assert.equal(res.status, "not_owned");
  assert.equal(resendSendCalls.length, 0, "NO Resend send for a non-owner");
  assert.equal(downloadCalls, 0, "NO storage download either");
});

test("Phase 3: owner of another order but line_items doesn't reference this good CANNOT resend", async () => {
  resetWorld();
  seedOrder({
    id: ORDER_ID,
    order_number: "SC000001",
    email: "buyer@example.com",
    customer_id: OWNER_CUSTOMER_ID,
    // Order is theirs, but it references a DIFFERENT digital good.
    line_items: [{ digital_good_id: "00000000-0000-0000-0000-000000000000", quantity: 1 }],
  });

  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [OWNER_CUSTOMER_ID],
    digitalGoodId: GOOD_ID,
  });

  assert.equal(res.status, "not_owned", "line-ref half of the ownership AND must hold");
  assert.equal(resendSendCalls.length, 0);
});

test("Phase 3: order doesn't exist at all → not_owned (leak-free)", async () => {
  resetWorld();
  // No seedOrder call.
  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [OWNER_CUSTOMER_ID],
    digitalGoodId: GOOD_ID,
  });
  assert.equal(res.status, "not_owned");
  assert.equal(resendSendCalls.length, 0);
});

test("Phase 3: empty ownerCustomerIds short-circuits to not_owned before touching Supabase", async () => {
  resetWorld();
  seedOrder({
    id: ORDER_ID,
    order_number: "SC000001",
    email: "buyer@example.com",
    customer_id: OWNER_CUSTOMER_ID,
    line_items: [{ digital_good_id: GOOD_ID, quantity: 1 }],
  });

  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [], // empty ⇒ nobody owns
    digitalGoodId: GOOD_ID,
  });
  assert.equal(res.status, "not_owned");
  assert.equal(resendSendCalls.length, 0);
});

test("Phase 3: coverage (non-downloadable) good → not_a_downloadable, no Resend send", async () => {
  resetWorld();
  goodRowVariant = coverageGoodRow;
  seedOrder({
    id: ORDER_ID,
    order_number: "SC000001",
    email: "buyer@example.com",
    customer_id: OWNER_CUSTOMER_ID,
    line_items: [{ digital_good_id: GOOD_ID, quantity: 1 }],
  });

  const res = await resendDigitalGoodForOwner({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    ownerCustomerIds: [OWNER_CUSTOMER_ID],
    digitalGoodId: GOOD_ID,
  });

  assert.equal(res.status, "not_a_downloadable");
  assert.equal(resendSendCalls.length, 0);
});
