/**
 * Unit tests for the June founder-approval gate PURE predicates — the money-amount extractor, the
 * gate decision, and the plain-language preview. The IO paths (raiseJuneRemedyApproval /
 * executeApprovedJuneRemedies) are exercised via the box-worker sweep, not here.
 *
 * Run:
 *   npx tsx --test src/lib/june-remedy-approval.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  remedyMoneyAmountCents,
  remedyNeedsFounderApproval,
  buildJuneApprovalPreview,
  DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS,
} from "./june-remedy-approval";

test("remedyMoneyAmountCents reads amount_cents on a money action", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: { amount_cents: 4800 } }), 4800);
});

test("remedyMoneyAmountCents reads replacement_amount_cents", () => {
  assert.equal(
    remedyMoneyAmountCents({ action_type: "dollar_replacement", payload: { replacement_amount_cents: 6995 } }),
    6995,
  );
});

test("remedyMoneyAmountCents returns null for a non-money action", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "change_next_date", payload: { amount_cents: 4800 } }), null);
});

test("remedyMoneyAmountCents returns null when amount is missing / non-finite", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: {} }), null);
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: { amount_cents: "x" } }), null);
  assert.equal(remedyMoneyAmountCents(null), null);
});

test("gate: sub-threshold refund runs autonomously (not gated)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 3000 } }, 5000);
  assert.equal(g.gated, false);
  assert.equal(g.amountCents, 3000);
  assert.equal(g.actionType, "partial_refund");
});

test("gate: at-threshold refund runs autonomously (strictly-above only)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 5000 } }, 5000);
  assert.equal(g.gated, false);
});

test("gate: over-threshold refund is gated", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 5001 } }, 5000);
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 5001);
});

test("gate: money action with UNKNOWN amount is gated (conservative)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: {} }, 5000);
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, null);
});

test("gate: non-money action never gated regardless of amount", () => {
  const g = remedyNeedsFounderApproval({ action_type: "change_next_date", payload: { amount_cents: 999999 } }, 5000);
  assert.equal(g.gated, false);
  assert.equal(g.actionType, "change_next_date");
});

test("gate: null/garbage remedy is not gated", () => {
  assert.equal(remedyNeedsFounderApproval(null, 5000).gated, false);
  assert.equal(remedyNeedsFounderApproval(undefined, 5000).gated, false);
});

test("gate: redeem_points_as_refund + create_replacement_order are money actions", () => {
  assert.equal(
    remedyNeedsFounderApproval({ action_type: "redeem_points_as_refund", payload: { amount_cents: 9000 } }, 5000).gated,
    true,
  );
  assert.equal(
    remedyNeedsFounderApproval(
      { action_type: "create_replacement_order", payload: { replacement_amount_cents: 9000 } },
      5000,
    ).gated,
    true,
  );
});

test("default threshold is $50", () => {
  assert.equal(DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS, 5000);
});

test("preview: refund reads plainly with name, subject, why", () => {
  const p = buildJuneApprovalPreview({
    actionType: "partial_refund",
    amountCents: 4800,
    customerName: "Susan",
    ticketSubject: "Wrong price",
    reasoning: "Portal showed the pre-discount price.",
  });
  assert.match(p, /Refund \$48\.00 to Susan on "Wrong price"\?/);
  assert.match(p, /Why: Portal showed the pre-discount price\./);
});

test("preview: replacement uses 'Send a replacement worth'", () => {
  const p = buildJuneApprovalPreview({ actionType: "create_replacement_order", amountCents: 6995 });
  assert.match(p, /Send a replacement worth \$69\.95\?/);
});

test("preview: unknown amount reads 'an unspecified amount'", () => {
  const p = buildJuneApprovalPreview({ actionType: "partial_refund", amountCents: null });
  assert.match(p, /Refund an unspecified amount\?/);
});
