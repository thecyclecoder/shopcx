/**
 * Unit tests for the PURE classifyPortalFailure() disposition logic. Built-in
 * node:test — no test-runner dependency. Run:
 *   npx tsx --test src/lib/portal/remediation.test.ts
 *
 * Focus: the last-item dismiss branch (portal-remediation-recognize-would-remove-
 * last-item spec). remove-line-item normalizes both the local pre-check and
 * Appstle's live guardrail to `would_remove_last_item`; route.ts stores that
 * stable code as the ticket error. The classifier must dismiss it (benign,
 * expected — the customer tried to empty a single-product sub) instead of falling
 * through to the catch-all `human` disposition that mis-escalated ticket
 * 055e807d (Pam Chadwick) as an "Unrecognized portal error".
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyPortalFailure, frequencySelfResolved, healPortalAction, type FailureContext, type TicketRow } from "./remediation";

const ctx = (error: string, extra: Partial<FailureContext> = {}): FailureContext => ({
  route: "removeLineItem",
  error,
  status: 400,
  payload: {},
  ...extra,
});

test("would_remove_last_item (the stable code route.ts stores) → dismiss", () => {
  // The exact value that reaches the classifier for ticket 055e807d.
  const r = classifyPortalFailure(ctx("would_remove_last_item"));
  assert.equal(r.disposition, "dismiss");
});

test("the friendly detail text (folded into error by getFailureContext) → dismiss", () => {
  const r = classifyPortalFailure(
    ctx("would_remove_last_item — At least one recurring item must remain on the subscription. Cancel the subscription instead."),
  );
  assert.equal(r.disposition, "dismiss");
});

test("friendly detail text alone (no code) still → dismiss", () => {
  const r = classifyPortalFailure(ctx("At least one recurring item must remain on the subscription."));
  assert.equal(r.disposition, "dismiss");
});

test("the replace-variants sibling would_remove_all_regular_products → dismiss", () => {
  const r = classifyPortalFailure(ctx("would_remove_all_regular_products"));
  assert.equal(r.disposition, "dismiss");
});

test("legacy raw Appstle last-item wording still → dismiss (fallback)", () => {
  const r = classifyPortalFailure(ctx("At least one subscription product must be present"));
  assert.equal(r.disposition, "dismiss");
});

test("insufficient points → dismiss (unrelated validation error, unchanged)", () => {
  const r = classifyPortalFailure(ctx("insufficient_points"));
  assert.equal(r.disposition, "dismiss");
});

test("transient Appstle operation lock → retry (not dismiss)", () => {
  const r = classifyPortalFailure(ctx("Billing operation is already in progress"));
  assert.equal(r.disposition, "retry");
});

test("a genuinely unrecognized error still → human", () => {
  const r = classifyPortalFailure(ctx("some brand new appstle failure mode"));
  assert.equal(r.disposition, "human");
});

// ── healPortalAction: frequency route case (portal-remediation-frequency-route-replay spec) ──
//
// Before Phase 1, `ctx.route === "frequency"` fell through to the default branch
// and returned `unsupported: true`, so remediatePortalTicket escalated a
// transiently-failing frequency change to a human even when the customer's own
// retry already landed it. Assert the case is now recognized (no `unsupported`
// flag) so the branch reaches the appstle replay whose same-value no-op guard
// closes the ticket on a change that already applied. The three cases below hit
// the payload-validation guards before any Appstle call, so the admin arg is
// never touched — cast to a stub instead of standing up a real Supabase mock.
const stubAdmin = null as unknown as SupabaseClient;

test("healPortalAction — frequency route with a missing contractId is recognized (not unsupported)", async () => {
  const r = await healPortalAction(stubAdmin, "ws_1", {
    route: "frequency",
    error: "",
    status: null,
    payload: { interval: "MONTH", intervalCount: 2 },
  });
  assert.equal(r.success, false);
  assert.equal(r.unsupported, undefined, "must reach the frequency branch, not the default `unsupported` fallback");
  assert.match(r.error || "", /contractId/i);
});

test("healPortalAction — frequency route with a missing intervalCount is recognized (not unsupported)", async () => {
  const r = await healPortalAction(stubAdmin, "ws_1", {
    route: "frequency",
    error: "",
    status: null,
    payload: { contractId: "gid://shopify/SubscriptionContract/1", interval: "MONTH" },
  });
  assert.equal(r.success, false);
  assert.equal(r.unsupported, undefined);
  assert.match(r.error || "", /intervalCount/i);
});

test("healPortalAction — frequency route with an invalid interval is recognized (not unsupported)", async () => {
  const r = await healPortalAction(stubAdmin, "ws_1", {
    route: "frequency",
    error: "",
    status: null,
    payload: { contractId: "gid://shopify/SubscriptionContract/1", interval: "fortnight", intervalCount: 1 },
  });
  assert.equal(r.success, false);
  assert.equal(r.unsupported, undefined);
  assert.match(r.error || "", /interval/i);
});

// ── frequencySelfResolved (Phase 2 — portal-remediation-frequency-route-replay-and-self-resolved) ──
//
// Originating ticket a7f9c0ed: a transient Appstle failure spawned a frequency
// portal-action-failed ticket; the customer's own retry landed the change and
// escalation-triage still mis-escalated the stale ticket. Assert both signals
// (a) a `portal.subscription.frequency_changed` event after the failure, and
// (b) the subscriptions row already matches the requested interval + count —
// return `resolved: true`, and neither signal → `resolved: false` (still runs
// replay/escalate downstream). Uses a minimal chainable Supabase stub keyed by
// (table, filters) — no test-runner mock library.
type Row = Record<string, unknown>;

class StubQuery {
  private op: "select" | "insert" | "update" | "delete" | null = null;
  private filters: Array<[string, string, unknown]> = [];
  constructor(private rows: Row[]) {}
  select(_cols: string) { this.op = "select"; return this; }
  insert(_body: Row) { this.op = "insert"; return Promise.resolve({ data: null, error: null }); }
  update(_body: Row) { this.op = "update"; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, val: unknown) { this.filters.push(["eq", col, val]); return this; }
  gte(col: string, val: unknown) { this.filters.push(["gte", col, val]); return this; }
  neq(col: string, val: unknown) { this.filters.push(["neq", col, val]); return this; }
  contains(_col: string, _val: unknown) { return this; }
  ilike(_col: string, _val: unknown) { return this; }
  order(_col: string, _opts?: unknown) { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) => this.filters.every(([op, col, val]) => {
      const rv = r[col];
      if (op === "eq") return rv === val;
      if (op === "gte") return String(rv) >= String(val);
      if (op === "neq") return rv !== val;
      return true;
    }));
  }
  limit(_n: number) { return Promise.resolve({ data: this.matched(), error: null }); }
  maybeSingle() { return Promise.resolve({ data: this.matched()[0] || null, error: null }); }
}

function stubDb(tables: Record<string, Row[]>): SupabaseClient {
  return { from: (table: string) => new StubQuery(tables[table] || []) } as unknown as SupabaseClient;
}

const CONTRACT = "gid://shopify/SubscriptionContract/999";
const FREQ_CTX: FailureContext = {
  route: "frequency",
  error: "Billing operation is already in progress",
  status: 502,
  payload: { contractId: CONTRACT, interval: "MONTH", intervalCount: 2 },
};
const TICKET: TicketRow = {
  id: "t_1",
  workspace_id: "ws_1",
  customer_id: "c_1",
  subject: "Portal action needs help: frequency",
  created_at: "2026-07-08T12:00:00Z",
  assigned_to: null,
  escalated_to: null,
  escalated_at: null,
  tags: ["portal-action-failed"],
};

test("frequencySelfResolved — signal (a): frequency_changed event AFTER the failure → resolved", async () => {
  // BEFORE Phase 2 this predicate did not exist, so remediatePortalTicket
  // ran the healPortalAction replay (or escalated if unsupported); a a7f9c0ed-
  // shaped ticket whose retry had already landed still became a human's problem.
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.subscription.frequency_changed",
      created_at: "2026-07-08T12:00:30Z",
      properties: { shopify_contract_id: CONTRACT, interval: "MONTH", intervalCount: 2 },
    }],
    subscriptions: [],
  });
  const r = await frequencySelfResolved(admin, "ws_1", FREQ_CTX, TICKET);
  assert.equal(r.resolved, true);
  assert.match(r.reason || "", /customer successfully changed the frequency herself/);
});

test("frequencySelfResolved — signal (b): subscriptions row already matches ctx payload → resolved", async () => {
  const admin = stubDb({
    customer_events: [],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      billing_interval: "month",
      billing_interval_count: 2,
    }],
  });
  const r = await frequencySelfResolved(admin, "ws_1", FREQ_CTX, TICKET);
  assert.equal(r.resolved, true);
  assert.match(r.reason || "", /already on every 2 month/);
});

test("frequencySelfResolved — no event + row is on the OLD interval → not resolved (replay still runs)", async () => {
  // The negative half of the spec's verification: a frequency change that
  // never landed still proceeds to replay/escalate.
  const admin = stubDb({
    customer_events: [],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      billing_interval: "month",
      billing_interval_count: 1,
    }],
  });
  const r = await frequencySelfResolved(admin, "ws_1", FREQ_CTX, TICKET);
  assert.equal(r.resolved, false);
});

test("frequencySelfResolved — event BEFORE the failure does not count (must be after)", async () => {
  // Guard #1 (gte failTime) — an earlier frequency_changed event isn't the
  // customer's post-failure retry; without this filter a routine change from
  // last week could false-positive a stale ticket into an auto-close.
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.subscription.frequency_changed",
      created_at: "2026-06-01T00:00:00Z", // long before the failure
      properties: { shopify_contract_id: CONTRACT, interval: "MONTH", intervalCount: 2 },
    }],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      billing_interval: "month",
      billing_interval_count: 1,
    }],
  });
  const r = await frequencySelfResolved(admin, "ws_1", FREQ_CTX, TICKET);
  assert.equal(r.resolved, false);
});

test("frequencySelfResolved — event for a DIFFERENT contract does not count (must match)", async () => {
  // Guard #2 (shopify_contract_id equality) — a resolved change on a different
  // subscription shouldn't close this contract's ticket.
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.subscription.frequency_changed",
      created_at: "2026-07-08T12:00:30Z",
      properties: { shopify_contract_id: "gid://shopify/SubscriptionContract/other", interval: "MONTH", intervalCount: 2 },
    }],
    subscriptions: [],
  });
  const r = await frequencySelfResolved(admin, "ws_1", FREQ_CTX, TICKET);
  assert.equal(r.resolved, false);
});
