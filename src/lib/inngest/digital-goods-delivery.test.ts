/**
 * Idempotency test for deliverDigitalGoodOnce.
 * (Phase 2 of docs/brain/specs/digital-goods-delivery.md.)
 *
 * Pins the invariant Phase 2's verification names:
 *   1. First call for (order, digital_good) sends exactly one Resend email
 *      with the PDF attached AND writes exactly one digital_good_deliveries
 *      ledger row.
 *   2. A re-processing call for the same (order, digital_good) sends zero
 *      additional Resend emails — the pre-dispatch guard hits the ledger
 *      row and short-circuits. Ledger row count stays at 1.
 *   3. extractDigitalGoodIds ignores lines with no digital_good_id and
 *      dedupes duplicate references.
 *
 * We stub the Supabase admin client + Resend client through Node's ESM
 * module cache BEFORE dynamic-importing digital-goods-delivery. The stub
 * client models the two tables the deliverer touches (digital_goods,
 * digital_good_deliveries) + workspaces + a `.storage.from(BUCKET).download`
 * that returns a tiny in-memory blob, and counts Resend `.emails.send`
 * calls so the "exactly one" invariant is directly assertable.
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

interface DeliveryLedgerRow {
  workspace_id: string;
  order_id: string;
  digital_good_id: string;
  resend_email_id: string | null;
  delivered_at: string;
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

const workspaceRow = {
  transactional_from_name: "Superfoods Company",
  name: "Superfoods",
};

function resetWorld(): void {
  ledger.length = 0;
  resendSendCalls = [];
  downloadCalls = 0;
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
          return { data: digitalGoodRow, error: null };
        }
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
const { deliverDigitalGoodOnce, extractDigitalGoodIds } =
  require("./digital-goods-delivery") as typeof import("./digital-goods-delivery");

// ── Tests ─────────────────────────────────────────────────────────

test("first delivery sends exactly one Resend email with PDF attached and writes exactly one ledger row", async () => {
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

test("re-processing the same (order, digital_good) sends no duplicate — pre-dispatch guard hits ledger", async () => {
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

  // A second call — same (order, good). MUST short-circuit.
  const second = await deliverDigitalGoodOnce({
    workspaceId: WORKSPACE_ID,
    orderId: ORDER_ID,
    orderNumber: "SC000001",
    customerEmail: "buyer@example.com",
    digitalGoodId: GOOD_ID,
  });
  assert.equal(second.status, "skipped_already_delivered");
  assert.equal(second.resend_email_id, "resend-1", "reports the original Resend id");
  // Resend NOT called a second time — the pre-dispatch guard hit.
  assert.equal(resendSendCalls.length, 1, "no duplicate email");
  // No duplicate ledger row.
  assert.equal(ledger.length, 1, "no duplicate ledger row");
  // Asset NOT downloaded a second time — the guard short-circuited before download.
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
