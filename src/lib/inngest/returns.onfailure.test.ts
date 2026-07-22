/**
 * Unit tests for returnsIssueRefundOnFailure — the Phase 2 escalation
 * handler that fires ONCE after `retries: 2` exhausts on
 * returns/issue-refund.
 *
 * Pins:
 *   - the refund exhaustion path inserts a dashboard_notifications row
 *     with the RETURN_REFUND_EXHAUSTED_TITLE (single row, not one per
 *     retry — this is the "throw don't return" spec's whole point).
 *   - the store-credit exhaustion path uses the CREDIT title +
 *     type=return_credit_exhausted metadata (routed via the return's
 *     resolution_type).
 *   - a payload missing workspace_id/return_id is nothing to escalate,
 *     but still beats ok:false so the loop's error rate registers.
 *   - every path beats ok:false via emitReactiveHeartbeat("returns-
 *     issue-refund", { ok:false }) — the artifact the Control Tower
 *     MONITORED_LOOPS tile rolls into its error-rate signal.
 *
 * We stub the Supabase admin client + the heartbeat module through
 * Node's ESM cache BEFORE dynamic-importing `./returns`, same pattern
 * refund.guard.test.ts already uses.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/returns.onfailure.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Notification = {
  workspace_id: string;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
};

type ReturnRow = {
  id: string;
  order_number: string;
  net_refund_cents: number;
  resolution_type: string;
  order_id: string | null;
};

let notifications: Notification[] = [];
let heartbeats: Array<{ id: string; ok: boolean }> = [];
let currentReturn: ReturnRow | null = null;

function resetWorld(): void {
  notifications = [];
  heartbeats = [];
  currentReturn = null;
}

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  insert(row: Notification): Promise<{ data: null; error: null }>;
  maybeSingle(): Promise<{ data: ReturnRow | null; error: null }>;
}

function makeFrom(table: string): QueryBuilder {
  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    async insert(row) {
      if (table === "dashboard_notifications") notifications.push(row);
      return { data: null, error: null };
    },
    async maybeSingle() {
      if (table === "returns") return { data: currentReturn, error: null };
      return { data: null, error: null };
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
moduleAny._cache[require.resolve("@/lib/control-tower/heartbeat")] = {
  exports: {
    emitReactiveHeartbeat: async (id: string, opts: { ok: boolean }) => {
      heartbeats.push({ id, ok: opts.ok });
    },
    emitCronHeartbeat: async () => undefined,
    emitAgentHeartbeat: async () => undefined,
    emitInlineAgentHeartbeat: async () => undefined,
    emitLoopHeartbeat: async () => undefined,
  },
};
// The Inngest client + shopify-returns + refund-ledger are transitively
// imported by returns.ts at module-load time; stub them so we don't
// need real Inngest / Supabase / Shopify credentials.
moduleAny._cache[require.resolve("@/lib/inngest/client")] = {
  exports: {
    inngest: {
      createFunction: (_opts: unknown, _fn: unknown) => ({ id: _opts }),
      send: async () => undefined,
    },
  },
};
moduleAny._cache[require.resolve("@/lib/shopify-returns")] = {
  exports: { closeReturn: async () => ({ success: true }) },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  returnsIssueRefundOnFailure,
  RETURN_REFUND_EXHAUSTED_TITLE,
  RETURN_CREDIT_EXHAUSTED_TITLE,
} = require("./returns") as typeof import("./returns");

const WORKSPACE_ID = "ws-1";
const RETURN_ID = "ret-1";

function failureArgs(overrides: Partial<{ workspace_id: string; return_id: string; err: string }> = {}) {
  return {
    event: {
      data: {
        event: {
          data: {
            workspace_id: overrides.workspace_id ?? WORKSPACE_ID,
            return_id: overrides.return_id ?? RETURN_ID,
          },
        },
      },
    },
    error: new Error(overrides.err ?? "Braintree refund failed: card declined"),
  };
}

// ── Refund exhaustion path ────────────────────────────────────────

test("onFailure: refund exhaustion inserts ONE dashboard row with the exhaustion title", async () => {
  resetWorld();
  currentReturn = {
    id: RETURN_ID,
    order_number: "SC133086",
    net_refund_cents: 13362,
    resolution_type: "refund_return",
    order_id: "ord-1",
  };
  await returnsIssueRefundOnFailure(failureArgs());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, RETURN_REFUND_EXHAUSTED_TITLE);
  assert.equal(notifications[0].workspace_id, WORKSPACE_ID);
  assert.match(notifications[0].body, /SC133086/);
  assert.match(notifications[0].body, /\$133\.62/);
  assert.match(notifications[0].body, /card declined/);
  assert.equal(notifications[0].metadata.type, "return_refund_exhausted");
  assert.equal(notifications[0].metadata.return_id, RETURN_ID);
});

// ── Store-credit exhaustion path ─────────────────────────────────

test("onFailure: store-credit exhaustion routes via resolution_type to the credit title + credit metadata", async () => {
  resetWorld();
  currentReturn = {
    id: RETURN_ID,
    order_number: "SC130193",
    net_refund_cents: 5000,
    resolution_type: "store_credit_return",
    order_id: "ord-2",
  };
  await returnsIssueRefundOnFailure(failureArgs({ err: "storeCreditAccountCredit rejected" }));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, RETURN_CREDIT_EXHAUSTED_TITLE);
  assert.equal(notifications[0].metadata.type, "return_credit_exhausted");
  assert.match(notifications[0].body, /storeCreditAccountCredit/);
});

// ── Heartbeat beats ok:false on every path ───────────────────────

test("onFailure: emits an ok:false heartbeat for returns-issue-refund on exhaustion", async () => {
  resetWorld();
  currentReturn = {
    id: RETURN_ID,
    order_number: "SC131156",
    net_refund_cents: 8000,
    resolution_type: "refund_return",
    order_id: null,
  };
  await returnsIssueRefundOnFailure(failureArgs({ err: "orderId is required" }));
  assert.deepEqual(heartbeats, [{ id: "returns-issue-refund", ok: false }]);
});

test("onFailure: missing workspace_id/return_id — still beats ok:false, no dashboard row", async () => {
  resetWorld();
  await returnsIssueRefundOnFailure({
    event: { data: { event: { data: {} } } },
    error: new Error("boom"),
  });
  assert.equal(notifications.length, 0, "must not escalate an unidentifiable failure");
  assert.deepEqual(heartbeats, [{ id: "returns-issue-refund", ok: false }]);
});
