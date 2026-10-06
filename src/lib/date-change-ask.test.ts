/**
 * Unit tests for detectDateChangeAsk — Phase 2 of
 * docs/brain/specs/inflection-resession-must-act-on-newest-ask.md.
 *
 * Fixtures taken directly from the dc31bf31 (Aug 2026) transcript:
 *   - 14:14 "Can we move order to Oct 30th as I ordered enough Aug n Sept???????"
 *     → MUST fire (isAsk=true, requestedDate pins Oct 30 of unknown year).
 *   - 14:06 "Thank you So much!!!!!"
 *     → MUST stay silent (isAsk=false, no false positive on a thank-you).
 *
 * Plus coverage of the decision-shape companion `decisionAddressesDateChange` and the
 * negative cases that keep the gate from false-firing on unrelated verbs ("move my
 * address", "pause my music").
 *
 * Pure helpers — no DB, no network, no clock. Run:
 *   npx tsx --test src/lib/date-change-ask.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectDateChangeAsk, decisionAddressesDateChange } from "./date-change-ask";

test("dc31bf31 14:14 fixture — 'Can we move order to Oct 30th…' MUST fire", () => {
  const res = detectDateChangeAsk(
    "Can we move order to Oct 30th as I ordered enough Aug n Sept???????",
  );
  assert.equal(res.isAsk, true, "the dc31bf31 scar message must be classified as a date-change ask");
  assert.equal(
    res.requestedDate,
    "0000-10-30",
    "Oct 30 must resolve to MM-DD with the sentinel 0000 year (no year on the message)",
  );
});

test("dc31bf31 14:06 fixture — 'Thank you So much!!!!!' MUST NOT fire", () => {
  const res = detectDateChangeAsk("Thank you So much!!!!!");
  assert.equal(res.isAsk, false, "a thank-you is not a date-change ask");
  assert.equal(res.requestedDate, null);
});

test("'push my next order to 10/30' → fires + resolves to US-slash date", () => {
  const res = detectDateChangeAsk("Please push my next order to 10/30");
  assert.equal(res.isAsk, true);
  assert.equal(res.requestedDate, "0000-10-30");
});

test("ISO literal date 2026-10-30 passes through verbatim", () => {
  const res = detectDateChangeAsk("delay my renewal to 2026-10-30");
  assert.equal(res.isAsk, true);
  assert.equal(res.requestedDate, "2026-10-30");
});

test("'move my next shipment to next month' → fires but requestedDate null (ambiguous)", () => {
  const res = detectDateChangeAsk("can you move my next shipment to next month");
  assert.equal(res.isAsk, true, "ambiguous dates still fire — the gate drives a clarify-question Direction");
  assert.equal(res.requestedDate, null);
});

test("'skip my next order' → fires on verb + subject anchor (no date)", () => {
  const res = detectDateChangeAsk("please skip my next order");
  assert.equal(res.isAsk, true);
  assert.equal(res.requestedDate, null);
});

test("'pause my subscription' → fires", () => {
  const res = detectDateChangeAsk("hey can you pause my subscription for a bit");
  assert.equal(res.isAsk, true);
});

test("'hold off on the next order' → fires on multi-word verb", () => {
  const res = detectDateChangeAsk("let's hold off on the next order for now");
  assert.equal(res.isAsk, true);
});

test("'move my address' → does NOT fire (no order-subject anchor)", () => {
  const res = detectDateChangeAsk("Can you move my shipping address to the new place?");
  assert.equal(res.isAsk, false, "'move my address' is an address change, not a date-change ask");
});

test("'pause my music' → does NOT fire (verb present, no subject)", () => {
  const res = detectDateChangeAsk("please pause my music");
  assert.equal(res.isAsk, false);
});

test("empty / whitespace → does NOT fire", () => {
  assert.equal(detectDateChangeAsk("").isAsk, false);
  assert.equal(detectDateChangeAsk("   ").isAsk, false);
});

test("'where is my order?' → does NOT fire (status question, not a date-change ask)", () => {
  const res = detectDateChangeAsk("where is my order?");
  assert.equal(res.isAsk, false);
});

test("decisionAddressesDateChange: change_next_date action satisfies the ask", () => {
  const ok = decisionAddressesDateChange({ actions: [{ type: "change_next_date" }] });
  assert.equal(ok, true);
});

test("decisionAddressesDateChange: skip_next_order action satisfies the ask", () => {
  const ok = decisionAddressesDateChange({ actions: [{ type: "skip_next_order" }] });
  assert.equal(ok, true);
});

test("decisionAddressesDateChange: pause action satisfies the ask", () => {
  const ok = decisionAddressesDateChange({ actions: [{ type: "pause" }] });
  assert.equal(ok, true);
});

test("decisionAddressesDateChange: needs_clarification=true satisfies the ask", () => {
  const ok = decisionAddressesDateChange({ needs_clarification: true });
  assert.equal(ok, true, "deferring to the customer via a clarifying question also addresses the ask");
});

test("decisionAddressesDateChange: a non-empty clarification_question satisfies the ask", () => {
  const ok = decisionAddressesDateChange({ clarification_question: "which date would you like?" });
  assert.equal(ok, true);
});

test("decisionAddressesDateChange: NEITHER a satisfying action NOR a clarify fails the gate", () => {
  const ok = decisionAddressesDateChange({
    actions: [{ type: "refund" }, { type: "send_message" }],
  });
  assert.equal(ok, false, "a status-only reply with no date action must fail the gate");
});

test("decisionAddressesDateChange: empty decision → false", () => {
  assert.equal(decisionAddressesDateChange({}), false);
});
