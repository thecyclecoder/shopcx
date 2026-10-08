/**
 * pickChargedSale — on a renewal retry, only a sale that actually charged the order may be
 * reused instead of charging again. Ground truth: the charge step passed no orderId and ran a
 * fresh sale on retry, so a sale whose result was lost (deploy mid-step) charged twice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pickChargedSale } from "./braintree";

test("a settled / settling / submitted / authorized sale counts", () => {
  for (const status of ["settled", "settling", "submitted_for_settlement", "authorized"]) {
    assert.deepEqual(pickChargedSale([{ id: "t1", type: "sale", status }]), { id: "t1", status });
  }
});

test("declined, failed, voided or gateway-rejected sales do NOT count (charge again)", () => {
  for (const status of ["processor_declined", "failed", "voided", "gateway_rejected", "settlement_declined"]) {
    assert.equal(pickChargedSale([{ id: "t1", type: "sale", status }]), null);
  }
});

test("a credit (refund) under the same orderId is not a sale", () => {
  assert.equal(pickChargedSale([{ id: "r1", type: "credit", status: "settled" }]), null);
});

test("picks the charged sale among several results; empty → null", () => {
  assert.deepEqual(
    pickChargedSale([
      { id: "a", type: "sale", status: "processor_declined" },
      { id: "b", type: "sale", status: "submitted_for_settlement" },
    ]),
    { id: "b", status: "submitted_for_settlement" },
  );
  assert.equal(pickChargedSale([]), null);
});
