/**
 * Unit tests for customer-find — the identify-from-conversation lookup the orchestrator was missing.
 *
 * THE INCIDENT (ticket 879dd36b, 2026-08-12). Mark McCartney wrote in to cancel and asked for a
 * refund. His email resolved to nothing, so the orchestrator escalated — narrating the search it
 * could not run: "Since we can't locate their account by email, this needs a human agent to search
 * by name/address." He had already supplied his full name, street address and phone. Every one of
 * the 14 data tools required a customerId; none could FIND one.
 *
 * Two customer-facing failures rode on that gap, and both are pinned here:
 *   - it promised "cancelling your deliveries and processing your refund are both things we can
 *     absolutely take care of" to a person it could not identify, and
 *   - it wrote "I can see from your address that you've been receiving shipments from us" in the
 *     same turn as an internal note saying no orders were visible. There were none.
 *
 * Run:  npx tsx --test src/lib/customer-find.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { phoneKey, surnameOf, findCustomerToText, type FindCustomerResult } from "./customer-find";

test("phoneKey normalises every format the customer might type", () => {
  const want = "6123881773";
  for (const v of ["6123881773", "612 388-1773", "+1 612 388 1773", "(612) 388-1773", "1-612-388-1773"]) {
    assert.equal(phoneKey(v), want, `failed for ${v}`);
  }
});

test("surnameOf takes the last token, so 'Mark McCartney' matches on the surname", () => {
  assert.equal(surnameOf("Mark McCartney"), "mccartney");
  assert.equal(surnameOf("  mark   mccartney  "), "mccartney");
  assert.equal(surnameOf("Cher"), "cher");
  assert.equal(surnameOf(""), "");
  assert.equal(surnameOf(null), "");
});

test("NOTHING SEARCHED must not read as 'no account' — the agent is told it has not looked", () => {
  const r: FindCustomerResult = { matches: [], searched: [], searchable: false };
  const txt = findCustomerToText(r);
  assert.match(txt, /nothing was searched/i);
  assert.match(txt, /Do NOT state or imply that no account exists/i);
});

test("a genuine empty result is stated as fact, and explicitly forbids promising a remedy", () => {
  // Mark's exact case: searched name + address + phone, found nobody.
  const r: FindCustomerResult = { matches: [], searched: ["name", "address", "phone"], searchable: true };
  const txt = findCustomerToText(r);
  assert.match(txt, /Searched name, address, phone/);
  assert.match(txt, /NO customer record matches/);
  // The two failures from the incident.
  assert.match(txt, /Do NOT promise a cancellation or refund/i);
  assert.match(txt, /another name, email, or card/i, "must suggest the spouse/gift-giver case");
});

test("candidates are rendered with confidence + the signals that earned it", () => {
  const r: FindCustomerResult = {
    searched: ["name", "address"],
    searchable: true,
    matches: [
      { id: "c1", email: "someone@example.com", confidence: "high", signals: ["name", "address"], previously_rejected: false },
      { id: "c2", email: "other@example.com", confidence: "low", signals: ["name"], previously_rejected: false },
    ],
  };
  const txt = findCustomerToText(r);
  assert.match(txt, /2 candidate account\(s\)/);
  assert.match(txt, /confidence high, matched on name\+address/);
  assert.match(txt, /confidence low, matched on name/);
  assert.match(txt, /NEVER act on a candidate without confirming identity/i);
});

test("a previously-rejected high match is surfaced as a re-confirm, never a silent link", () => {
  const r: FindCustomerResult = {
    searched: ["address"],
    searchable: true,
    matches: [{ id: "c1", email: "x@example.com", confidence: "high", signals: ["address"], previously_rejected: true }],
  };
  assert.match(findCustomerToText(r), /prior link was rejected — re-confirm, never auto-link/i);
});

test("the empty-result text never contains the hallucinated reassurance", () => {
  const r: FindCustomerResult = { matches: [], searched: ["address"], searchable: true };
  const txt = findCustomerToText(r).toLowerCase();
  assert.ok(!txt.includes("receiving shipments"), "must not seed the 2026-08-12 fabrication");
  assert.ok(!txt.includes("i can see"), "must not invite an unverified claim");
});
