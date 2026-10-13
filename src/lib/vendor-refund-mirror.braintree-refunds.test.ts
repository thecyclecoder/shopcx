/**
 * Pins the Braintree refund-extraction shape.
 *
 * The defect this exists for: `extractBraintreeRefunds` read `txn.refunds`, a field
 * the Braintree Node SDK never populates on `transaction.find()`. It returns
 * `refundIds` (ids only). So the reconcile mirrored ZERO refunds while reporting
 * ok:true — 4 orders / $75.36 of real gateway refunds stayed invisible to the ledger
 * and to the double-refund guard (measured 2026-09-30, orders SHOPCX6/7/19/33).
 *
 * It shipped green because its verification was a grep for the symbol name, which
 * proves the function exists and says nothing about what it does. This test is the
 * behavioural check that would have caught it.
 *
 * Run: npx tsx --test src/lib/vendor-refund-mirror.braintree-refunds.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBraintreeRefunds } from "./vendor-refund-mirror";

// The real shape observed from the gateway: the SALE carries refundIds only, and the
// amount lives on the separately-fetched refund transaction.
const SALE = { id: "h3bp2n43", amount: "250.35", refundIds: ["702vsmjf"] };
const REFUND_TXN = { id: "702vsmjf", amount: "30.02", refundedTransactionId: "h3bp2n43" };

test("maps refund TRANSACTIONS resolved from refundIds (the SDK's real shape)", () => {
  const out = extractBraintreeRefunds(SALE, [REFUND_TXN]);
  assert.equal(out.length, 1);
  assert.equal(out[0].braintreeRefundId, "702vsmjf");
  assert.equal(out[0].braintreeTransactionId, "h3bp2n43");
  // 30.02 dollars -> cents, NOT the sale's 250.35
  assert.equal(out[0].amountCents, 3002);
});

test("a sale with refundIds but no fetched refund txns yields nothing (cannot invent an amount)", () => {
  assert.deepEqual(extractBraintreeRefunds(SALE, []), []);
});

test("still accepts an inline refunds array when an API shape supplies one", () => {
  const out = extractBraintreeRefunds({ id: "s1", refunds: [{ id: "r1", amount: "4.95" }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].amountCents, 495);
});

test("de-dupes when the same refund arrives inline AND as a fetched transaction", () => {
  const out = extractBraintreeRefunds(
    { id: "s1", refunds: [{ id: "r1", amount: "7.99" }] },
    [{ id: "r1", amount: "7.99" }],
  );
  assert.equal(out.length, 1, "one refund, not two");
  assert.equal(out[0].amountCents, 799);
});

test("skips zero, negative and unparseable amounts", () => {
  const out = extractBraintreeRefunds({ id: "s1" }, [
    { id: "a", amount: "0" },
    { id: "b", amount: "-5.00" },
    { id: "c", amount: "not-a-number" },
    { id: "", amount: "9.99" },
    { id: "d", amount: "32.40" },
  ]);
  assert.deepEqual(out.map((r) => r.braintreeRefundId), ["d"]);
  assert.equal(out[0].amountCents, 3240);
});
