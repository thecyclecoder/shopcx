/**
 * Unit tests for the Phase-2 durable dispatcher helper.
 *
 * Pins the exact behavior the spec's verification bullets require:
 *   1. `dispatchInboundMessage` STAMPS `dispatch_pending_at` on the just-inserted `ticket_messages`
 *      row BEFORE firing the `ticket/inbound-message` event (intent-first ordering — a crash
 *      between stamp and send leaves a lost-send recoverable; the reverse leaves it invisible).
 *   2. When `dispatchMessageId` is null (sentinel wakes — journey/complete, submit-payment,
 *      apply-playbook), NO stamp is written; the event still fires.
 *   3. `clearDispatchIntent` clears un-cleared stamps on the ticket when the handler claims the
 *      turn, so an un-cleared stamp older than the Phase-3 settle window is unambiguously a
 *      lost send (not "handler declined the turn").
 *
 *   npx tsx --test src/lib/inngest/dispatch-inbound-message.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Op = {
  kind: "update" | "send";
  table?: string;
  patch?: Record<string, unknown>;
  filters?: Array<{ col: string; val: unknown }>;
  nonNullFilters?: string[];
  event?: Record<string, unknown>;
};

const trace: Op[] = [];

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Array<{ col: string; val: unknown }> = [];
      const nonNullFilters: string[] = [];
      let patch: Record<string, unknown> | null = null;
      const chain = {
        update(v: Record<string, unknown>) {
          patch = v;
          return chain;
        },
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return chain;
        },
        not(col: string, _op: "is", _val: null) {
          nonNullFilters.push(col);
          return chain;
        },
        then(resolve: (v: unknown) => void) {
          trace.push({
            kind: "update",
            table,
            patch: patch ?? {},
            filters: [...filters],
            nonNullFilters: [...nonNullFilters],
          });
          resolve({ data: null, error: null });
        },
      };
      return chain;
    },
  };
}

const fakeInngest = {
  send: async (event: Record<string, unknown>) => {
    trace.push({ kind: "send", event });
  },
};

// Wire the inngest client stub BEFORE requiring dispatch-inbound-message (same pattern as
// src/lib/cart-gifts.test.ts). The helper's `import { inngest } from "./client"` resolves to our
// stub, so no real Inngest network call happens.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("./client")] = { exports: { inngest: fakeInngest } };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dispatchInboundMessage, clearDispatchIntent } =
  require("./dispatch-inbound-message") as typeof import("./dispatch-inbound-message");

const MSG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TICKET_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WORKSPACE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function reset() {
  trace.length = 0;
}

test("verification bullet — stamps dispatch_pending_at BEFORE the send", async () => {
  reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await dispatchInboundMessage({
    admin: fakeAdmin() as any,
    workspaceId: WORKSPACE_ID,
    ticketId: TICKET_ID,
    messageBody: "hello",
    channel: "chat",
    isNewTicket: false,
    dispatchMessageId: MSG_ID,
  });
  // Two ops recorded — the stamp update, then the event send. Order matters: if the send comes
  // before the stamp, a crash between them leaves an un-recoverable lost send.
  assert.equal(trace.length, 2);
  assert.equal(trace[0].kind, "update");
  assert.equal(trace[0].table, "ticket_messages");
  assert.ok(trace[0].patch && typeof trace[0].patch.dispatch_pending_at === "string");
  // Compare-and-set on the specific message id — a caller can never stamp a stale row.
  assert.ok(trace[0].filters?.some((f) => f.col === "id" && f.val === MSG_ID));
  assert.ok(trace[0].filters?.some((f) => f.col === "ticket_id" && f.val === TICKET_ID));
  assert.equal(trace[1].kind, "send");
  assert.equal((trace[1].event as { name: string }).name, "ticket/inbound-message");
});

test("verification bullet — sentinel (null messageId) fires WITHOUT stamping", async () => {
  reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await dispatchInboundMessage({
    admin: fakeAdmin() as any,
    workspaceId: WORKSPACE_ID,
    ticketId: TICKET_ID,
    messageBody: "address_confirmed",
    channel: "system",
    isNewTicket: false,
    dispatchMessageId: null,
  });
  // Only the send — sentinels have no inbound-message row to stamp.
  assert.equal(trace.length, 1);
  assert.equal(trace[0].kind, "send");
});

test("clearDispatchIntent clears un-cleared stamps on the ticket (handler claim)", async () => {
  reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await clearDispatchIntent(fakeAdmin() as any, TICKET_ID);
  assert.equal(trace.length, 1);
  const op = trace[0];
  assert.equal(op.kind, "update");
  assert.equal(op.table, "ticket_messages");
  // Clears to null.
  assert.equal(op.patch?.dispatch_pending_at, null);
  // Scoped by ticket_id.
  assert.ok(op.filters?.some((f) => f.col === "ticket_id" && f.val === TICKET_ID));
  // Narrowed to un-cleared rows only (idempotent — clearing a clear ticket is a no-op).
  assert.ok(op.nonNullFilters?.includes("dispatch_pending_at"));
});

test("extra payload keys pass through to the event data", async () => {
  reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await dispatchInboundMessage({
    admin: fakeAdmin() as any,
    workspaceId: WORKSPACE_ID,
    ticketId: TICKET_ID,
    messageBody: "payment_method_added",
    channel: "system",
    isNewTicket: false,
    dispatchMessageId: null,
    extra: { journey_session_id: "sess-1", payment_method_id: "pm-1" },
  });
  const evt = trace.find((t) => t.kind === "send")?.event as { data: Record<string, unknown> };
  assert.equal(evt.data.journey_session_id, "sess-1");
  assert.equal(evt.data.payment_method_id, "pm-1");
});
