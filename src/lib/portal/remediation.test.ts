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
import { classifyPortalFailure, computeOrderNowBillability, enrichOrderNowContext, frequencySelfResolved, healPortalAction, swapSelfResolved, type FailureContext, type TicketRow } from "./remediation";

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

// ── Phase 4 of inflection-resession-must-act-on-newest-ask ───────────────────
// payment_failed_update_blocked is the stale triage note the dc31bf31 ticket
// stacked on top of a recovered dunning cycle. The pure classifier now returns
// the `journey_add_payment_method` disposition for this error class; the DB-aware
// remediatePortalTicket consumer then suppresses (internal / recovered) or routes
// to the add-payment-method journey.

test("Phase 4: payment_failed_update_blocked → journey_add_payment_method (never bare 'human')", () => {
  const r = classifyPortalFailure(ctx("payment_failed_update_blocked"));
  assert.equal(
    r.disposition,
    "journey_add_payment_method",
    "payment_failed_update_blocked must get the explicit branch, not fall through to 'human'",
  );
  assert.match(r.reason, /payment_failed_update_blocked/);
});

test("Phase 4: payment_failed_update_blocked substring in a larger error still → journey_add_payment_method", () => {
  // The portal/route.ts folds detail text into `error`, so the classifier matches
  // on an .includes() rather than an exact-equal. A detailed string must still
  // land on the branch, not fall through.
  const r = classifyPortalFailure(
    ctx("payment_failed_update_blocked — gateway still rejects the vaulted card"),
  );
  assert.equal(r.disposition, "journey_add_payment_method");
});

test("Phase 4: a close-but-not-matching error does NOT trigger the journey branch", () => {
  // Make sure the branch doesn't greedily match unrelated 'payment_failed' strings.
  const r = classifyPortalFailure(ctx("payment_failed_other_class"));
  assert.equal(
    r.disposition,
    "human",
    "unrelated payment_failed_* errors still fall through to the human branch",
  );
});

// ── Remove-payment-method guard codes (portal-remove-card-guard-rejections-are-
// validation-not-human-escalations spec) ──
//
// The stable codes emitted by remove-payment-method.ts are UI-gating validation:
// PaymentMethodsSection.tsx maps each to plain-language customer guidance, and
// cards are customer-only by PCI design (no agent remedy). The PRIMARY suppression
// is route.ts VALIDATION_ERRORS (stops the ticket at all); this is the backstop
// for any that predate the guard or reach classification via another path. Real
// case: ticket c969f235 (G Esposito) — a legitimate pinned_to_active_subscription
// refusal was escalating to a human three times over the same Mastercard.
for (const code of [
  "pinned_to_active_subscription",
  "last_card_for_active_subscription",
  "not_removable_here",
  "payment_method_not_found",
  "payment_method_not_in_group",
  "missing_paymentMethodId",
]) {
  test(`remove-payment-method guard code ${code} → dismiss (not the human fallthrough)`, () => {
    const r = classifyPortalFailure(ctx(code));
    assert.equal(r.disposition, "dismiss");
  });
}

// ── vault_declined (portal-vault-classify-processor-decline-vs-error spec) ──
//
// vaultPaymentMethod throws a typed VaultCreateError with code='vault_declined'
// on a processor decline / gateway rejection (customer's own issuer or the
// merchant's risk rule saying no). payment-method-update surfaces that as
// { error: 'vault_declined' } (HTTP 400 — customer-fixable, not a 5xx). Cards
// are customer-only by PCI design, so a clean decline has nothing for a human
// to do — dismiss. Real case: ticket ea66c607, 24 retries and 22 tickets on
// the same class of decline before the fix. The primary suppression is
// [[portal__route]]'s VALIDATION_ERRORS set (stops the ticket at all); this
// classifier is the backstop for any that predate the guard or reach it via
// another path. A genuine gateway/config error still returns vault_failed and
// classifies as human (SDK broken, misconfig, no_braintree_customer, etc.).
test("vault_declined (processor decline / gateway rejection) → dismiss", () => {
  const r = classifyPortalFailure(ctx("vault_declined", { route: "updatePaymentMethod" }));
  assert.equal(r.disposition, "dismiss");
});

test("vault_failed (genuine gateway/config error) still → human", () => {
  const r = classifyPortalFailure(ctx("vault_failed", { route: "updatePaymentMethod" }));
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

// ── swapSelfResolved (portal-replaceVariants-self-resolved-auto-dismiss spec) ──
//
// Originating ticket c19bd92b: the first `replaceVariants` call 400'd on a
// stale `oldLineId`, spawning a portal-action-failed ticket; the retry landed
// and the sub line is now the requested variant. A generic Appstle 400 on
// replaceVariants classifies as `human` (no replay in `healPortalAction`), so
// like cancel the guard runs BEFORE the disposition acts. Assert both signals
// (a) a `portal.items.swapped` event for this contract after the failure, and
// (b) the local `subscriptions.items[]` already contains the target variant —
// return `resolved: true`. The negative case (no event + old items) → not
// resolved so the ticket keeps its normal path to `human`.
const SWAP_TICKET: TicketRow = {
  id: "t_swap",
  workspace_id: "ws_1",
  customer_id: "c_1",
  subject: "Portal action needs help: replacevariants",
  created_at: "2026-07-09T15:00:00Z",
  assigned_to: null,
  escalated_to: null,
  escalated_at: null,
  tags: ["portal-action-failed"],
};
const SWAP_CTX_MAP: FailureContext = {
  route: "replacevariants",
  error: "Unrecognized Appstle 400 on replaceVariants",
  status: 502,
  payload: {
    contractId: CONTRACT,
    oldLineId: "96cf0252",
    // The record shape the customer's payload uses when a browser sends the
    // object form (Peach Mango): { "12345": 1 }.
    newVariants: { "12345": 1 },
  },
};
const SWAP_CTX_ARR: FailureContext = {
  ...SWAP_CTX_MAP,
  payload: {
    contractId: CONTRACT,
    oldLineId: "96cf0252",
    // The array shape { variantId, quantity } — the alternate accepted form.
    newVariants: [{ variantId: "12345", quantity: 1 }],
  },
};

test("swapSelfResolved — signal (a): portal.items.swapped event AFTER the failure → resolved", async () => {
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.items.swapped",
      created_at: "2026-07-09T15:00:30Z",
      properties: { shopify_contract_id: CONTRACT, newVariants: { "12345": 1 } },
    }],
    subscriptions: [],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_MAP, SWAP_TICKET);
  assert.equal(r.resolved, true);
  assert.match(r.reason || "", /customer successfully swapped the subscription items herself/);
});

test("swapSelfResolved — signal (b): subscriptions.items already contains the target variant → resolved", async () => {
  // The robust signal — the retry landed regardless of event source.
  const admin = stubDb({
    customer_events: [],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      items: [{ variant_id: "12345", title: "Peach Mango" }],
    }],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_MAP, SWAP_TICKET);
  assert.equal(r.resolved, true);
  assert.match(r.reason || "", /already contains the requested variant \(12345\)/);
});

test("swapSelfResolved — signal (b) works with the array-shaped newVariants payload too", async () => {
  // The handler accepts both `{ id: qty }` and `[{ variantId, quantity }]`.
  // The self-resolved detector normalizes both, so an already-landed swap
  // matches regardless of which shape the customer's client sent.
  const admin = stubDb({
    customer_events: [],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      items: [{ variant_id: "12345", title: "Peach Mango" }],
    }],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_ARR, SWAP_TICKET);
  assert.equal(r.resolved, true);
});

test("swapSelfResolved — no event + sub items still on the OLD variant → not resolved (falls through to human)", async () => {
  // Negative half: the failure was NOT self-resolved. Guard bails so the
  // normal remediatePortalTicket branch (human, since there's no replay) runs.
  const admin = stubDb({
    customer_events: [],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      items: [{ variant_id: "99999", title: "Original Superfood Tabs" }],
    }],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_MAP, SWAP_TICKET);
  assert.equal(r.resolved, false);
});

test("swapSelfResolved — event BEFORE the failure does not count (must be after)", async () => {
  // Guard #1 (gte failTime) — an earlier swap event isn't this ticket's retry.
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.items.swapped",
      created_at: "2026-06-01T00:00:00Z", // long before the failure
      properties: { shopify_contract_id: CONTRACT, newVariants: { "12345": 1 } },
    }],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      items: [{ variant_id: "99999" }],
    }],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_MAP, SWAP_TICKET);
  assert.equal(r.resolved, false);
});

test("swapSelfResolved — event for a DIFFERENT contract does not count (must match)", async () => {
  // Guard #2 (shopify_contract_id equality) — a resolved swap on another sub
  // shouldn't close this contract's ticket.
  const admin = stubDb({
    customer_events: [{
      workspace_id: "ws_1",
      customer_id: "c_1",
      event_type: "portal.items.swapped",
      created_at: "2026-07-09T15:00:30Z",
      properties: { shopify_contract_id: "gid://shopify/SubscriptionContract/other", newVariants: { "12345": 1 } },
    }],
    subscriptions: [{
      workspace_id: "ws_1",
      shopify_contract_id: CONTRACT,
      items: [{ variant_id: "99999" }],
    }],
  });
  const r = await swapSelfResolved(admin, "ws_1", SWAP_CTX_MAP, SWAP_TICKET);
  assert.equal(r.resolved, false);
});

test("swapSelfResolved — missing contractId → not resolved (bail cleanly)", async () => {
  const admin = stubDb({ customer_events: [], subscriptions: [] });
  const r = await swapSelfResolved(admin, "ws_1", { ...SWAP_CTX_MAP, payload: {} }, SWAP_TICKET);
  assert.equal(r.resolved, false);
});

// ── Order Now failure context (Phase 1 — sol-checks-billability-and-delivery-before-answering-order-now-failures) ──
//
// Ground truth: ticket for Ashley Denson (2026-10-08). Sol answered an `ordernow`
// `already_billed` failure by claiming a DELIVERED order was "on its way" and that a
// STRANDED sub "will keep coming automatically". getFailureContext now attaches an
// `orderNow` block carrying the real delivery state + billability so Sol can't guess.

test("computeOrderNowBillability — active sub with a future date → billable", () => {
  const r = computeOrderNowBillability({ status: "active", next_billing_date: "2026-11-01T00:00:00Z", cancelled_at: null, last_payment_status: "succeeded" });
  assert.equal(r.billable, true);
});

test("computeOrderNowBillability — cancelled sub → NOT billable (never renews)", () => {
  const r = computeOrderNowBillability({ status: "cancelled", next_billing_date: null, cancelled_at: "2026-10-01T00:00:00Z" });
  assert.equal(r.billable, false);
  assert.match(r.reason, /cancelled/);
});

test("computeOrderNowBillability — active but no next_billing_date → NOT billable (stranded)", () => {
  const r = computeOrderNowBillability({ status: "active", next_billing_date: null });
  assert.equal(r.billable, false);
  assert.match(r.reason, /stranded|never renew/);
});

test("computeOrderNowBillability — failed last payment → NOT billable (in dunning, skips)", () => {
  const r = computeOrderNowBillability({ status: "active", next_billing_date: "2026-11-01T00:00:00Z", last_payment_status: "failed" });
  assert.equal(r.billable, false);
  assert.match(r.reason, /dunning|failed/);
});

// Minimal chainable stub supporting the enrich query shape (eq/or/order/limit/maybeSingle).
class ONQuery {
  private filters: Array<[string, unknown]> = [];
  private orContract: string | null = null;
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  or(expr: string) { this.orContract = (expr.match(/\.eq\.([^,]+)/)?.[1]) ?? null; return this; }
  order() { return this; }
  limit() { return this; }
  private matched(): Row[] {
    return this.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v) &&
      (this.orContract == null || r.shopify_contract_id === this.orContract || r.migrated_from_contract_id === this.orContract));
  }
  maybeSingle() { return Promise.resolve({ data: this.matched()[0] ?? null, error: null }); }
}
function onDb(tables: Record<string, Row[]>): SupabaseClient {
  return { from: (t: string) => new ONQuery(tables[t] || []) } as unknown as SupabaseClient;
}

const ON_TICKET: TicketRow = {
  id: "t_on",
  workspace_id: "ws_1",
  customer_id: "c_1",
  subject: "Portal action needs help: ordernow",
  created_at: "2026-10-08T12:00:00Z",
  assigned_to: null,
  escalated_to: null,
  escalated_at: null,
  tags: ["portal-action-failed"],
};
const ON_CTX = (payload: Row = { contractId: "55501" }, route = "ordernow"): FailureContext => ({
  route,
  error: "already_billed — This order has already been placed.",
  status: 409,
  payload,
});

test("enrichOrderNowContext — exposes billability AND last-order delivery for ordernow", async () => {
  const admin = onDb({
    subscriptions: [{ id: "s_1", workspace_id: "ws_1", shopify_contract_id: "55501", customer_id: "c_1", status: "active", next_billing_date: "2026-11-05T00:00:00Z", cancelled_at: null, last_payment_status: "succeeded" }],
    orders: [{ workspace_id: "ws_1", subscription_id: "s_1", order_number: "SC139301", created_at: "2026-10-01T00:00:00Z", delivery_status: "delivered", delivered_at: "2026-10-02T00:00:00Z", fulfillment_status: "fulfilled" }],
  });
  const out = await enrichOrderNowContext(admin, ON_TICKET, ON_CTX());
  assert.ok(out.orderNow, "orderNow block attached");
  // Billability exposed.
  assert.equal(out.orderNow!.subscription!.nextDateBillable, true);
  assert.equal(out.orderNow!.subscription!.next_billing_date, "2026-11-05T00:00:00Z");
  // Last-order delivery exposed — delivered, NOT in transit.
  assert.equal(out.orderNow!.lastOrderDelivery!.delivery_status, "delivered");
  assert.equal(out.orderNow!.lastOrderDelivery!.delivered_at, "2026-10-02T00:00:00Z");
  assert.equal(out.orderNow!.lastOrderDelivery!.order_number, "SC139301");
});

test("enrichOrderNowContext — the Ashley shape: delivered order + stranded sub reads NOT billable", async () => {
  const admin = onDb({
    // Stranded: active flag but no next date → never renews.
    subscriptions: [{ id: "s_2", workspace_id: "ws_1", shopify_contract_id: "55501", customer_id: "c_1", status: "active", next_billing_date: null, cancelled_at: null, last_payment_status: "succeeded" }],
    orders: [{ workspace_id: "ws_1", subscription_id: "s_2", order_number: "SC139301", created_at: "2026-10-01T00:00:00Z", delivery_status: "delivered", delivered_at: "2026-10-02T00:00:00Z", fulfillment_status: "fulfilled" }],
  });
  const out = await enrichOrderNowContext(admin, ON_TICKET, ON_CTX());
  assert.equal(out.orderNow!.subscription!.nextDateBillable, false);
  assert.equal(out.orderNow!.lastOrderDelivery!.delivered_at, "2026-10-02T00:00:00Z");
});

test("enrichOrderNowContext — non-ordernow route is left untouched (no orderNow block)", async () => {
  const admin = onDb({ subscriptions: [], orders: [] });
  const out = await enrichOrderNowContext(admin, ON_TICKET, ON_CTX({ contractId: "55501" }, "changedate"));
  assert.equal(out.orderNow, undefined);
});

test("enrichOrderNowContext — falls back to the ticket customer's sub when no contract id", async () => {
  const admin = onDb({
    subscriptions: [{ id: "s_3", workspace_id: "ws_1", customer_id: "c_1", status: "active", next_billing_date: "2026-12-01T00:00:00Z", cancelled_at: null, last_payment_status: "succeeded" }],
    orders: [],
  });
  const out = await enrichOrderNowContext(admin, ON_TICKET, ON_CTX({}));
  assert.ok(out.orderNow);
  assert.equal(out.orderNow!.subscription!.id, "s_3");
  assert.equal(out.orderNow!.lastOrderDelivery, null);
});
