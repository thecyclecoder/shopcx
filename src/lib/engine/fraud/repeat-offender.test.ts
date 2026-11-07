/**
 * Engine repeat-offender matching tests, built from real incidents (PII scrubbed:
 * names, emails, and zips are stand-ins; only the SHAPE of each incident is kept).
 *
 *  - Reinard ring (2026-06-11): a confirmed ringleader "stephen <surname>" on a
 *    throwaway custom domain came back as "benstephen <surname>" with a fresh
 *    local part on the same domain and a fresh address (ship = bill). Exact
 *    email/name/address all missed; same_email_domain + fuzzy_name must fire.
 *  - 7704 Romaine St (2026-08/09): 4 orders at one address were refunded and the
 *    case confirmed. A new order to that address under the same surname must
 *    match as a repeat offender, even when the street is written "Roma.ine St.".
 *
 * Run: npx tsx --test src/lib/engine/fraud/repeat-offender.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  matchRepeatOffender,
  filterToConfirmedCustomers,
  confirmedFraudOrderIds,
  summarizeRepeatOffenderMatches,
  repeatOffenderTitle,
  orderUuids as engineOrderUuids,
  type ConfirmedFraudCase,
  type ConfirmedFraudOrder,
} from "./index";
import { orderUuids as legacyOrderUuids } from "../../fraud-detector";

const CASE_A = "11111111-1111-4111-8111-111111111111";
const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const addr = (first: string, last: string, address1: string, zip: string) => ({
  first_name: first, last_name: last, address1, zip, city: "Springfield", province: "CA",
});

test("Reinard ring: custom domain + padded first name on a fresh address → same_email_domain + fuzzy_name", () => {
  const ringleader: ConfirmedFraudOrder = {
    id: ORDER_A,
    order_number: "SC100001",
    email: "stephen.r@ringdomain-example.com",
    customer_id: "cust-ringleader",
    shipping_address: addr("Stephen", "Ringer", "12 Old Mill Rd", "93001"),
    billing_address: addr("Stephen", "Ringer", "12 Old Mill Rd", "93001"),
  };
  const cases: ConfirmedFraudCase[] = [{ id: CASE_A, order_ids: [ORDER_A], confirmed_customer_ids: ["cust-ringleader"] }];
  // GraphQL camelCase shape on the incoming order — both shapes are read.
  const incoming = {
    email: "BenS2@RingDomain-Example.com ",
    shipping_address: { firstName: "BenStephen", lastName: "Ringer", address1: "88 Fresh Ave", zip: "94002" },
    billing_address: { firstName: "BenStephen", lastName: "Ringer", address1: "88 Fresh Ave", zip: "94002" },
  };

  const matches = matchRepeatOffender(incoming, [ringleader], cases);
  assert.deepEqual(matches, [
    { type: "same_email_domain", this_value: "bens2@ringdomain-example.com", fraud_value: "stephen.r@ringdomain-example.com", fraud_order: "SC100001", fraud_case_id: CASE_A },
    // shipping + billing both fire fuzzy_name; dedupe keeps the shipping one
    { type: "fuzzy_name", this_value: "benstephen ringer", fraud_value: "stephen ringer", fraud_order: "SC100001", fraud_case_id: CASE_A },
  ]);

  const s = summarizeRepeatOffenderMatches(matches);
  assert.deepEqual(s.linkedCaseIds, [CASE_A]);
  assert.equal(
    s.summary,
    `Order linked to 1 confirmed fraud case(s): same_email_domain: "bens2@ringdomain-example.com" matches fraud order SC100001 ("stephen.r@ringdomain-example.com"); fuzzy_name: "benstephen ringer" matches fraud order SC100001 ("stephen ringer")`,
  );
});

test("Reinard ring on a freemail domain: same domain alone never matches", () => {
  const fo: ConfirmedFraudOrder = {
    id: ORDER_A, order_number: "SC1", email: "stephen@gmail.com", customer_id: "c",
    shipping_address: addr("Stephen", "Ringer", "1 A St", "10001"), billing_address: null,
  };
  const incoming = { email: "someone.else@gmail.com", shipping_address: addr("Maria", "Lopez", "9 B St", "20002"), billing_address: null };
  assert.deepEqual(matchRepeatOffender(incoming, [fo]), []);
});

test("7704 Romaine St re-open: same street + zip under the same surname is a repeat offender", () => {
  const refunded: ConfirmedFraudOrder = {
    id: ORDER_A, order_number: "SC200001", email: "first.buyer@gmail.com", customer_id: "cust-romaine",
    shipping_address: addr("Jane", "Doe", "7704 Romaine St", "90000"),
    billing_address: addr("Jane", "Doe", "7704 Romaine St", "90000"),
  };
  const cases: ConfirmedFraudCase[] = [{ id: CASE_A, order_ids: [ORDER_A], confirmed_customer_ids: ["cust-romaine"] }];
  // New account, new email, punctuation injected into the street.
  const incoming = {
    email: "new.buyer@yahoo.com",
    shipping_address: addr("John", "Doe", "7704 Roma.ine St.", "90000"),
    billing_address: addr("John", "Doe", "7704 Roma.ine St.", "90000"),
  };
  const types = matchRepeatOffender(incoming, [refunded], cases).map((m) => m.type);
  assert.deepEqual(types, [
    "shipping_address",
    "billing_address",
    "ship_to_fraud_billing",
    "bill_to_fraud_shipping",
    "same_lastname_same_address",
  ]);
  const sameAddr = matchRepeatOffender(incoming, [refunded], cases).find((m) => m.type === "same_lastname_same_address")!;
  assert.equal(sameAddr.this_value, "john doe @ 7704 romaine st");
  assert.equal(sameAddr.fraud_value, "jane doe @ 7704 romaine st");
});

test("email signals: gmail alias, exact email, and exact name", () => {
  const fo: ConfirmedFraudOrder = {
    id: ORDER_A, order_number: "SC3", email: "pat@gmail.com", customer_id: "c",
    shipping_address: addr("Pat", "Lee", "1 A St", "10001"), billing_address: null,
  };
  const alias = matchRepeatOffender({ email: "pat+x1@gmail.com", shipping_address: null, billing_address: null }, [fo]);
  assert.deepEqual(alias.map((m) => [m.type, m.fraud_case_id]), [["gmail_alias", ""]]);
  const exact = matchRepeatOffender({ email: " PAT@gmail.com", shipping_address: addr("pat", "lee", "5 Z St", "30003"), billing_address: null }, [fo]);
  assert.deepEqual(exact.map((m) => m.type), ["exact_email", "same_name", "fuzzy_name"]);
});

test("legacy quirk: dedupe keys on order_number, so two null-numbered fraud orders collapse", () => {
  const mk = (id: string): ConfirmedFraudOrder => ({
    id, order_number: null, email: null, customer_id: "c",
    shipping_address: addr("Al", "Ng", "3 C St", "40004"), billing_address: null,
  });
  const incoming = { email: null, shipping_address: addr("Al", "Ng", "3 C St", "40004"), billing_address: null };
  const m = matchRepeatOffender(incoming, [mk(ORDER_A), mk(ORDER_B)]);
  assert.deepEqual(m.map((x) => x.type), ["shipping_address", "same_lastname_same_address", "same_name", "fuzzy_name"]);
});

test("only individually-confirmed customers' orders seed matches; ids filtered to UUIDs like legacy", () => {
  const cases: ConfirmedFraudCase[] = [
    { id: CASE_A, order_ids: [ORDER_A, "5551234", ORDER_B], confirmed_customer_ids: ["fraudster"] },
  ];
  assert.deepEqual(confirmedFraudOrderIds(cases), [ORDER_A, ORDER_B]);
  const raw = [ORDER_A, 42, "5551234", null, ORDER_B.toUpperCase()];
  assert.deepEqual(engineOrderUuids(raw), legacyOrderUuids(raw));
  const kept = filterToConfirmedCustomers(cases, [
    { id: ORDER_A, customer_id: "fraudster" },
    { id: ORDER_B, customer_id: "same-bin-bystander" },
    { id: "x", customer_id: null },
  ]);
  assert.deepEqual(kept.map((o) => o.id), [ORDER_A]);
});

test("case title matches legacy wording", () => {
  assert.equal(repeatOffenderTitle("SC5", "999"), "Order SC5 matches confirmed fraud");
  assert.equal(repeatOffenderTitle(null, "999"), "Order 999 matches confirmed fraud");
});
