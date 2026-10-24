/**
 * Engine name-mismatch signal tests, including the legacy camelCase billing
 * quirk (plan §5 item 4) that the Phase 2 shadow must reproduce.
 *
 * Run: npx tsx --test src/lib/engine/fraud/name-mismatch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateNameMismatch } from "./index";

const customer = { first_name: "Maria", last_name: "Lopez" };

test("different billing name → finding with legacy title + evidence", () => {
  const f = evaluateNameMismatch(
    { shopify_order_id: "5550001", billing_address: { first_name: "Chris", last_name: "Stone" } },
    customer,
    { ignore_last_name_match: true },
  )!;
  assert.equal(f.title, `Billing name "Chris Stone" ≠ customer "Maria Lopez" on order #5550001`);
  assert.deepEqual(f.evidence, {
    billing_name: "Chris Stone",
    customer_name: "Maria Lopez",
    billing_first: "Chris",
    billing_last: "Stone",
    customer_first: "Maria",
    customer_last: "Lopez",
    last_names_match: false,
    order_id: "5550001",
  });
});

test("same name (case/whitespace-insensitive) → no finding", () => {
  assert.equal(evaluateNameMismatch({ shopify_order_id: "1", billing_address: { first_name: " MARIA", last_name: "lopez " } }, customer, {}), null);
});

test("same last name: flagged unless ignore_last_name_match", () => {
  const order = { shopify_order_id: "1", billing_address: { first_name: "Jose", last_name: "Lopez" } };
  assert.equal(evaluateNameMismatch(order, customer, { ignore_last_name_match: true }), null);
  const f = evaluateNameMismatch(order, customer, { ignore_last_name_match: false })!;
  assert.equal(f.evidence.last_names_match, true);
});

test("missing names on either side → no finding", () => {
  assert.equal(evaluateNameMismatch({ shopify_order_id: "1", billing_address: null }, customer, {}), null);
  assert.equal(evaluateNameMismatch({ shopify_order_id: "1", billing_address: {} }, customer, {}), null);
  assert.equal(evaluateNameMismatch({ shopify_order_id: "1", billing_address: { first_name: "X" } }, { first_name: null, last_name: null }, {}), null);
});

test("LEGACY QUIRK: camelCase billing (GraphQL backfill shape) silently skips the rule", () => {
  const camel = { shopify_order_id: "1", billing_address: { firstName: "Chris", lastName: "Stone" } };
  assert.equal(evaluateNameMismatch(camel, customer, {}), null);
});
