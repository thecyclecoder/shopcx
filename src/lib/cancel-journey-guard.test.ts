/**
 * Unit tests for the cancel-journey-guard predicates.
 *
 * Named failing state (spec verification): a customer who accepted a
 * `saved_remedy` and then immediately re-asks "cancel my subscription"
 * must be detected — the next cancel-journey delivery has to route
 * past the remedy step, not re-present the same offer.
 *
 * Pure — no network. Run:
 *   npx tsx --test src/lib/cancel-journey-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeCancelIntent,
  hasRecentSavedRemedy,
  isCancelTriggerIntent,
} from "./cancel-journey-guard";

test("looksLikeCancelIntent — the ticket-6c12a925 wording (customer re-asks after accepted save) trips (named failing state)", () => {
  assert.equal(looksLikeCancelIntent("Cancel my subscription"), true);
  assert.equal(looksLikeCancelIntent("please cancel"), true);
  assert.equal(looksLikeCancelIntent("<p>i just want to cancel it</p>"), true);
  assert.equal(looksLikeCancelIntent("stop charging me"), true);
  assert.equal(looksLikeCancelIntent("unsubscribe me"), true);
  // Common misspellings from the DB match_patterns list.
  assert.equal(looksLikeCancelIntent("cancle my sub please"), true);
  assert.equal(looksLikeCancelIntent("canel it"), true);
});

test("looksLikeCancelIntent — carrier-cancellation reports do NOT fire (avoids false-positive re-send on a shipping ticket)", () => {
  assert.equal(
    looksLikeCancelIntent("shipping was cancelled by the carrier — where is my refund?"),
    false,
  );
  assert.equal(
    looksLikeCancelIntent("UPS says cancelled by shipper"),
    false,
  );
});

test("looksLikeCancelIntent — an offhand mention that isn't a request does NOT fire", () => {
  assert.equal(looksLikeCancelIntent("thanks for the help"), false);
  assert.equal(looksLikeCancelIntent("when's my next order?"), false);
  assert.equal(looksLikeCancelIntent(""), false);
  assert.equal(looksLikeCancelIntent(null), false);
});

test("isCancelTriggerIntent — accepts every trigger_intent flavor for the cancel journey", () => {
  assert.equal(isCancelTriggerIntent("cancel_subscription"), true);
  assert.equal(isCancelTriggerIntent("cancel"), true);
  assert.equal(isCancelTriggerIntent("Cancellation"), true);
  assert.equal(isCancelTriggerIntent("skip_next_order"), false);
  assert.equal(isCancelTriggerIntent(null), false);
});

// ── hasRecentSavedRemedy (thin DB helper) ──
//
// The DB stub below is deliberately minimal — same in-memory shape as
// `sol-direction-apply.test.ts` uses. It exercises the query chain
// (`.eq('workspace_id')`.`.eq('ticket_id')`.`.eq('status','completed')`.
// `.ilike('outcome','saved_%')`.`.order()`.`.limit(1)`.`.maybeSingle()`)
// so a regression in the filter chain (e.g. dropping the ilike, or
// scoping by customer_id instead of ticket_id) is caught here.

interface Row {
  [k: string]: unknown;
}
function makeAdmin(rows: Row[]) {
  function makeBuilder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderDesc = false;
    let orderCol: string | null = null;
    const b = {
      select(_cols: string) {
        return b;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return b;
      },
      ilike(col: string, pat: string) {
        const rx = new RegExp("^" + pat.replace(/%/g, ".*") + "$", "i");
        filters.push((r) => typeof r[col] === "string" && rx.test(r[col] as string));
        return b;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        orderDesc = opts?.ascending === false;
        return b;
      },
      limit(_n: number) {
        return b;
      },
      maybeSingle() {
        void table;
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderCol) {
          const dir = orderDesc ? -1 : 1;
          out = out.slice().sort((a, b2) => {
            const av = a[orderCol!] as string | null;
            const bv = b2[orderCol!] as string | null;
            if (av === bv) return 0;
            if (av === null || av === undefined) return 1;
            if (bv === null || bv === undefined) return -1;
            return av > bv ? dir : -dir;
          });
        }
        return Promise.resolve({ data: out[0] ?? null, error: null });
      },
    };
    return b;
  }
  return {
    from(_table: string) {
      return makeBuilder(_table);
    },
  } as unknown as Parameters<typeof hasRecentSavedRemedy>[0];
}

const WS = "ws-1";
const TID = "tkt-6c12a925";

test("hasRecentSavedRemedy — ticket with completed saved_remedy → hasSavedRemedy=true (named failing state — ticket 6c12a925)", async () => {
  const admin = makeAdmin([
    {
      id: "sess-1",
      workspace_id: WS,
      ticket_id: TID,
      status: "completed",
      outcome: "saved_remedy",
      completed_at: "2026-08-15T10:00:00Z",
    },
  ]);
  const out = await hasRecentSavedRemedy(admin, WS, TID);
  assert.equal(out.hasSavedRemedy, true);
  assert.equal(out.sessionId, "sess-1");
});

test("hasRecentSavedRemedy — pending-only session → hasSavedRemedy=false (status gate)", async () => {
  const admin = makeAdmin([
    {
      id: "sess-2",
      workspace_id: WS,
      ticket_id: TID,
      status: "pending",
      outcome: null,
      completed_at: null,
    },
  ]);
  const out = await hasRecentSavedRemedy(admin, WS, TID);
  assert.equal(out.hasSavedRemedy, false);
});

test("hasRecentSavedRemedy — only completed session was `cancelled` → hasSavedRemedy=false (ilike gate)", async () => {
  const admin = makeAdmin([
    {
      id: "sess-3",
      workspace_id: WS,
      ticket_id: TID,
      status: "completed",
      outcome: "cancelled",
      completed_at: "2026-08-15T10:00:00Z",
    },
  ]);
  const out = await hasRecentSavedRemedy(admin, WS, TID);
  assert.equal(out.hasSavedRemedy, false);
});

test("hasRecentSavedRemedy — other ticket's saved session does NOT leak in (ticket_id scope)", async () => {
  const admin = makeAdmin([
    {
      id: "sess-4",
      workspace_id: WS,
      ticket_id: "other-ticket",
      status: "completed",
      outcome: "saved_remedy",
      completed_at: "2026-08-15T10:00:00Z",
    },
  ]);
  const out = await hasRecentSavedRemedy(admin, WS, TID);
  assert.equal(out.hasSavedRemedy, false);
});
