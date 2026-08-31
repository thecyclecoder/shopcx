/**
 * Unit tests for `detectRepeatQuestion` — the pure predicate the unified ticket handler
 * calls before sending a playbook response, to decide whether the response is a substantial
 * repeat of the last outbound AI message on the ticket.
 *
 * Mirrors the Phase-2 verification of
 * docs/brain/specs/playbook-drift-classifier-sees-the-pending-question.md.
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/playbook-repeat-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  detectRepeatQuestion,
  normalizeForRepeatCheck,
} from "./playbook-repeat-guard";

test("no lastOutbound → nothing can repeat (first playbook message on the ticket)", () => {
  const v = detectRepeatQuestion({
    pending: "Hi Suzanne — did you not receive your order at all?",
    lastOutbound: null,
  });
  assert.equal(v.repeat, false);
});

test("normalized exact match → repeat (verbatim re-send)", () => {
  const q = "Could you confirm this is the correct shipping address for the replacement?";
  const v = detectRepeatQuestion({ pending: q, lastOutbound: q });
  assert.equal(v.repeat, true);
});

test("HTML wrapping on lastOutbound normalizes away — the send path stores HTML", () => {
  const pending = "Did you not receive your order at all?";
  const stored = "<p>Did you not receive your order at all?</p>";
  const v = detectRepeatQuestion({ pending, lastOutbound: stored });
  assert.equal(v.repeat, true);
});

test("intro/sign-off boilerplate differs but the question sentence is identical → repeat", () => {
  // First ask (isFirstMessage=true) carries the personality intro.
  // Second ask (isFirstMessage=false) drops the intro — question body is unchanged.
  const firstAsk = "Hi Suzanne! Thanks for reaching out. Did you not receive your order at all?";
  const secondAsk = "Did you not receive your order at all?";
  const v = detectRepeatQuestion({ pending: secondAsk, lastOutbound: firstAsk });
  assert.equal(v.repeat, true, "substring containment must catch the boilerplate-differs re-ask");
});

test("Suzanne ground-truth: identical address-confirm re-ask with different closing → repeat", () => {
  const firstAsk =
    "<p>Just to confirm, is 123 Maple St, Boston, MA 02116 the correct shipping address for the replacement? Reply yes or share the right one.</p>";
  const secondAsk =
    "Just to confirm, is 123 Maple St, Boston, MA 02116 the correct shipping address for the replacement? Reply yes or share the right one. Thanks!";
  const v = detectRepeatQuestion({ pending: secondAsk, lastOutbound: firstAsk });
  assert.equal(v.repeat, true, "the second address-confirm ask on the Suzanne ticket must trip the guard");
});

test("high-Jaccard reword of the same question → repeat", () => {
  const first = "Could you confirm the shipping address on the replacement order is still correct for delivery?";
  // Single-word swap ("Could" → "Can"). Same question, same intent, same info request —
  // Jaccard over filtered tokens sits well above the threshold.
  const second = "Can you confirm the shipping address on the replacement order is still correct for delivery?";
  const v = detectRepeatQuestion({ pending: second, lastOutbound: first });
  assert.equal(v.repeat, true);
});

test("genuinely different next-step question → not a repeat (playbook is progressing)", () => {
  const firstAsk = "Did you not receive your order at all, or did some items arrive damaged?";
  const secondAsk =
    "Thanks for confirming. Could you share the shipping address you'd like the replacement sent to?";
  const v = detectRepeatQuestion({ pending: secondAsk, lastOutbound: firstAsk });
  assert.equal(v.repeat, false, "a different question in the same playbook must NOT trip the guard");
});

test("short ack with a couple shared tokens → NOT flagged (Jaccard suppressed on short messages)", () => {
  // Both messages are tiny; a shared token or two must NOT be enough to trip.
  const v = detectRepeatQuestion({ pending: "thanks anyway", lastOutbound: "no thanks needed" });
  assert.equal(v.repeat, false);
});

test("empty pending → nothing meaningful to check", () => {
  const v = detectRepeatQuestion({ pending: "", lastOutbound: "Did you not receive your order at all?" });
  assert.equal(v.repeat, false);
});

test("HTML-only lastOutbound with no text content → nothing to compare against", () => {
  const v = detectRepeatQuestion({ pending: "Did you not receive your order at all?", lastOutbound: "<p></p>" });
  assert.equal(v.repeat, false);
});

test("normalizeForRepeatCheck strips tags, entities, case, and whitespace", () => {
  const n = normalizeForRepeatCheck(
    "  <p>Hi&nbsp;there —  IS  this the correct   address?</p>",
  );
  assert.equal(n, "hi there — is this the correct address?");
});

test("repeat note quotes the pending excerpt so the sysNote surfaces the defect in-thread", () => {
  const q = "Could you please confirm this is the correct shipping address for the replacement order?";
  const v = detectRepeatQuestion({ pending: q, lastOutbound: q });
  assert.equal(v.repeat, true);
  if (v.repeat) {
    assert.match(v.note, /correct shipping address/);
  }
});
