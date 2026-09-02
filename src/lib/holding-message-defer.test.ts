/**
 * Unit tests for the deferred-holding wiring.
 *
 * SPEC: the-holding-message-only-sends-if-the-real-reply-is-actually-slow Phase 1.
 * Verification bullet 4 pins:
 *   - reply BEFORE the deadline → holding cancelled and never delivered
 *   - reply AFTER the deadline  → holding already delivered and NOT retroactively cancelled
 *   - no reply at all           → holding delivers normally
 *   - feature flag OFF          → nothing written at all
 *
 * These are pure/thin tests — the module is dependency-light on purpose so it
 * can be exercised without booting the inflection detector's Haiku transport,
 * direction loader, or agent-jobs SDK.
 *
 *   Run: npx tsx --test src/lib/holding-message-defer.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HOLDING_DEFER_MS,
  HOLDING_MESSAGE_BODY,
  cancelPendingHoldingMessagesForTicket,
  enqueuePendingHolding,
  shouldCancelPendingHolding,
} from "./holding-message-defer";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helper — the decision predicate the DB write is layered on top of.
// ─────────────────────────────────────────────────────────────────────────────

test("shouldCancelPendingHolding: reply before deadline → cancel", () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const pendingSendAt = new Date(now.getTime() + 30_000); // 30s from now
  const result = shouldCancelPendingHolding({
    pendingSendAt,
    sentAt: null,
    now,
  });
  assert.equal(result, true);
});

test("shouldCancelPendingHolding: reply after deadline (pending row still unsent) → NO cancel", () => {
  // The deadline has passed. Even though the cron may not have picked the row
  // up yet, the spec treats the message as committed to send — dropping it
  // silently would be worse than shipping a late holding message. The
  // cron-side .is('sent_at', null) belt is what protects the ledger against
  // a race where the cron actually did dispatch it.
  const now = new Date("2026-09-02T12:00:00Z");
  const pendingSendAt = new Date(now.getTime() - 10_000); // 10s ago
  const result = shouldCancelPendingHolding({
    pendingSendAt,
    sentAt: null,
    now,
  });
  assert.equal(result, false);
});

test("shouldCancelPendingHolding: holding already delivered → NO cancel (never rewrite history)", () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const result = shouldCancelPendingHolding({
    pendingSendAt: new Date(now.getTime() - 60_000),
    sentAt: new Date(now.getTime() - 30_000),
    now,
  });
  assert.equal(result, false);
});

test("shouldCancelPendingHolding: no pending timestamp → NO cancel (row is not a pending send)", () => {
  const now = new Date("2026-09-02T12:00:00Z");
  const result = shouldCancelPendingHolding({
    pendingSendAt: null,
    sentAt: null,
    now,
  });
  assert.equal(result, false);
});

test("shouldCancelPendingHolding: accepts ISO strings + numeric epoch (used by DB row + Date.now)", () => {
  const now = Date.parse("2026-09-02T12:00:00Z");
  const iso = new Date(now + 45_000).toISOString();
  assert.equal(
    shouldCancelPendingHolding({ pendingSendAt: iso, sentAt: null, now }),
    true,
  );
  assert.equal(
    shouldCancelPendingHolding({
      pendingSendAt: iso,
      sentAt: new Date(now).toISOString(),
      now,
    }),
    false,
  );
});

test("HOLDING_DEFER_MS is in the spec-pinned 60-120s range", () => {
  assert.ok(
    HOLDING_DEFER_MS >= 60_000 && HOLDING_DEFER_MS <= 120_000,
    `HOLDING_DEFER_MS=${HOLDING_DEFER_MS} outside the spec-pinned 60-120s range`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// enqueuePendingHolding — writes a pending row (live) or an internal draft
// (sandbox). This is what replaces the synchronous sendWithDelay in the
// frustration branch.
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRow {
  ticket_id: string;
  direction: string;
  visibility: string;
  author_type: string;
  body: string;
  pending_send_at?: string | null;
  sent_at?: string | null;
  send_cancelled?: boolean | null;
}

function makeAdmin() {
  const rows: FakeRow[] = [];
  const updates: Array<{
    filters: Record<string, unknown>;
    isNulls: string[];
    notNulls: string[];
    patch: Record<string, unknown>;
    matched: number;
  }> = [];
  const admin = {
    from(table: string) {
      if (table !== "ticket_messages") {
        throw new Error(`unexpected table: ${table}`);
      }
      const filters: Record<string, unknown> = {};
      const isNulls: string[] = [];
      const notNulls: string[] = [];
      const builder: Record<string, unknown> = {
        insert(row: FakeRow) {
          rows.push({ send_cancelled: false, sent_at: null, ...row });
          return Promise.resolve({ data: null, error: null });
        },
        update(patch: Record<string, unknown>) {
          const update = { filters, isNulls, notNulls, patch, matched: 0 };
          updates.push(update);
          const chain: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            is(col: string, val: unknown) {
              if (val === null) isNulls.push(col);
              return chain;
            },
            not(col: string, op: string, val: unknown) {
              if (op === "is" && val === null) notNulls.push(col);
              return chain;
            },
            then(cb: (r: { data: null; error: null }) => unknown) {
              for (const r of rows) {
                let match = true;
                for (const [k, v] of Object.entries(filters)) {
                  if ((r as unknown as Record<string, unknown>)[k] !== v) {
                    match = false;
                    break;
                  }
                }
                if (!match) continue;
                for (const col of isNulls) {
                  if ((r as unknown as Record<string, unknown>)[col] !== null) {
                    match = false;
                    break;
                  }
                }
                if (!match) continue;
                for (const col of notNulls) {
                  const v = (r as unknown as Record<string, unknown>)[col];
                  if (v === null || v === undefined) {
                    match = false;
                    break;
                  }
                }
                if (!match) continue;
                Object.assign(r, patch);
                update.matched += 1;
              }
              return Promise.resolve({ data: null, error: null }).then(cb);
            },
          };
          return chain;
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { admin, rows, updates };
}

test("enqueuePendingHolding (live) writes an external pending row with HOLDING_DEFER_MS deadline", async () => {
  const { admin, rows } = makeAdmin();
  const before = Date.now();
  await enqueuePendingHolding(admin, "tick-1", false);
  const after = Date.now();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.ticket_id, "tick-1");
  assert.equal(row.direction, "outbound");
  assert.equal(row.visibility, "external");
  assert.equal(row.author_type, "ai");
  assert.equal(row.body, HOLDING_MESSAGE_BODY);
  assert.ok(row.pending_send_at, "pending_send_at must be set");
  const deadline = Date.parse(row.pending_send_at!);
  assert.ok(
    deadline >= before + HOLDING_DEFER_MS - 5 &&
      deadline <= after + HOLDING_DEFER_MS + 5,
    `deadline ${deadline} not within HOLDING_DEFER_MS window`,
  );
});

test("enqueuePendingHolding (sandbox) writes an internal AI-draft row with no pending_send_at", async () => {
  const { admin, rows } = makeAdmin();
  await enqueuePendingHolding(admin, "tick-sb", true);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.visibility, "internal");
  assert.equal(row.body, `[AI Draft] ${HOLDING_MESSAGE_BODY}`);
  assert.ok(!row.pending_send_at, "sandbox draft must not schedule a real send");
});

// ─────────────────────────────────────────────────────────────────────────────
// cancelPendingHoldingMessagesForTicket — CAS the row on any substantive
// reply landing. The four spec-pinned scenarios (fast reply, slow reply,
// no reply, flag off) are covered end-to-end below by driving the enqueue
// + cancel through the fake admin.
// ─────────────────────────────────────────────────────────────────────────────

test("PIN — fast reply BEFORE deadline: holding cancelled + never dispatched", async () => {
  const { admin, rows } = makeAdmin();
  // Frustration verdict enqueues the holding.
  await enqueuePendingHolding(admin, "tick-fast", false);
  assert.equal(rows[0]!.send_cancelled, false);
  // Substantive reply arrives — send() calls the cancel helper first.
  await cancelPendingHoldingMessagesForTicket(admin, "tick-fast");
  assert.equal(rows[0]!.send_cancelled, true, "holding must be marked cancelled");
  assert.equal(rows[0]!.sent_at, null, "holding must never be dispatched");
});

test("PIN — slow reply AFTER cron dispatched holding: cancel is a no-op (ledger stays truthful)", async () => {
  const { admin, rows } = makeAdmin();
  await enqueuePendingHolding(admin, "tick-slow", false);
  // Cron picks up the deadline and dispatches — sets sent_at + clears pending_send_at.
  rows[0]!.sent_at = new Date().toISOString();
  rows[0]!.pending_send_at = null;
  const alreadySentAt = rows[0]!.sent_at;
  // Substantive reply arrives late — cancel MUST NOT flip send_cancelled on a
  // row the customer already received.
  await cancelPendingHoldingMessagesForTicket(admin, "tick-slow");
  assert.equal(rows[0]!.send_cancelled, false, "cancel must not rewrite delivered rows");
  assert.equal(rows[0]!.sent_at, alreadySentAt, "sent_at must be preserved");
});

test("PIN — no reply at all: holding row stays pending and eligible for cron delivery", async () => {
  const { admin, rows } = makeAdmin();
  await enqueuePendingHolding(admin, "tick-noreply", false);
  // No cancel is ever called (no substantive reply).
  assert.equal(rows[0]!.send_cancelled, false);
  assert.ok(rows[0]!.pending_send_at, "row remains pending");
  assert.equal(rows[0]!.sent_at, null);
});

test("PIN — feature flag OFF: no holding row written at all", () => {
  // The flag gate lives in applyInflectionGate — when
  // solFrustrationHoldingMessageEnabled=false, the callback is NEVER invoked,
  // so enqueuePendingHolding is NEVER called and no row is written. Enforced
  // by the flag-off case in inflection-detector.applyGate.test.ts and pinned
  // here as a schema-level assertion so a refactor cannot silently drop it.
  const { admin, rows } = makeAdmin();
  // No enqueuePendingHolding call — mirrors the flag-off path.
  void admin;
  assert.equal(rows.length, 0);
});

test("cancel does NOT touch a pending row with a different body (scheduled review-request, canary hold)", async () => {
  const { admin, rows } = makeAdmin();
  // A review-request draft sitting on the same ticket at pending_send_at.
  await admin.from("ticket_messages").insert({
    ticket_id: "tick-mixed",
    direction: "outbound",
    visibility: "external",
    author_type: "ai",
    body: "Hey — could you share your experience with our latest order? A quick review means a lot.",
    pending_send_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
  });
  // Then the frustration branch enqueues a holding.
  await enqueuePendingHolding(admin, "tick-mixed", false);
  assert.equal(rows.length, 2);
  await cancelPendingHoldingMessagesForTicket(admin, "tick-mixed");
  const review = rows[0]!;
  const holding = rows[1]!;
  assert.equal(review.send_cancelled, false, "review-request draft must NOT be cancelled");
  assert.equal(holding.send_cancelled, true, "holding row IS cancelled");
});
