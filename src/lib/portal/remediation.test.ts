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
import { classifyPortalFailure, healPortalAction, type FailureContext } from "./remediation";

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
