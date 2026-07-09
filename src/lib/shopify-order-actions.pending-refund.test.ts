/**
 * Unit test for `findPendingRefundTxn` — the pure detector that keeps a
 * second refund from firing while an earlier one is still settling on the
 * gateway (Amy / SC133495, 2026-07).
 *
 * A $67.81 PayPal refund sat `pending` for a day; a duplicate attempt hit
 * Shopify's `{"base":["Transaction cannot be refunded"]}` (the balance was
 * fully allocated: sale − settled refund − pending refund = $0), which the
 * box surfaced as a cryptic hard-failure escalation. This pins the detection
 * that turns that into an honest "already processing" instead.
 *
 * Run:
 *   npx tsx --test src/lib/shopify-order-actions.pending-refund.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findPendingRefundTxn } from "./shopify-order-actions";

// The actual SC133495 transaction shape (trimmed to the fields we read).
const SC133495_TXNS = [
  { id: 8905743958189, kind: "sale", status: "success", gateway: "paypal", amount: "71.56" },
  { id: 8935221559469, kind: "refund", status: "success", gateway: "paypal", amount: "3.75" },
  { id: 8942626013357, kind: "refund", status: "pending", gateway: "paypal", amount: "67.81" },
];

test("finds the pending refund among settled sale + settled refund", () => {
  const hit = findPendingRefundTxn(SC133495_TXNS);
  assert.ok(hit, "expected a pending refund to be detected");
  assert.equal(hit!.amount, "67.81");
  assert.equal(hit!.gateway, "paypal");
});

test("case-insensitive on status (PENDING / Pending)", () => {
  assert.ok(findPendingRefundTxn([{ kind: "refund", status: "PENDING", amount: "10.00" }]));
  assert.ok(findPendingRefundTxn([{ kind: "refund", status: "Pending", amount: "10.00" }]));
});

test("returns null when the only refund already settled (nothing in flight)", () => {
  const settled = [
    { kind: "sale", status: "success", amount: "71.56" },
    { kind: "refund", status: "success", amount: "3.75" },
  ];
  assert.equal(findPendingRefundTxn(settled), null);
});

test("a pending SALE (not a refund) is not a pending refund — no false positive", () => {
  const pendingSale = [{ kind: "sale", status: "pending", amount: "71.56" }];
  assert.equal(findPendingRefundTxn(pendingSale), null);
});

test("null / empty / undefined inputs are safe", () => {
  assert.equal(findPendingRefundTxn(undefined), null);
  assert.equal(findPendingRefundTxn(null), null);
  assert.equal(findPendingRefundTxn([]), null);
});
