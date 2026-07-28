/**
 * one-open-escalation-per-thing Phase 3 — pins the NAMED FAILING STATE for the asked-blocks-re-ask
 * guard. The 2026-07-28 incident: the founder answered June's card at 23:47 with a specific
 * investigative lens; June opened four more cards over the next 2.5h without engaging with the
 * answer. Fix: while a `god_mode_approvals.status='asked'` card exists for the same (ticket,
 * category) subject, block a new mint — the founder is waiting on June to consume the answer, not
 * a fresh card that ignores it. Bounded: after N mints in the window, emit ONE summary card.
 *
 * `computeReAskBlock` is the pure fork the mint site runs after reading `readReAskState`. Kept pure
 * so the "block:asked_open vs block:ceiling vs no-block" decision is testable without a Supabase
 * seam.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/june-remedy-approval-reask.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeReAskBlock, JUNE_REASK_CEILING } from "./june-remedy-approval";

test("computeReAskBlock — an open `asked` card blocks the mint (this is Phase 3's core invariant)", () => {
  const decision = computeReAskBlock({
    openAskedCount: 1,
    askedQuestionText: "look at the customer's LTV before refunding",
    mintCountInWindow: 3,
  });
  assert.equal(decision.block, true);
  if (decision.block) {
    assert.equal(decision.kind, "asked_open");
    if (decision.kind === "asked_open") {
      assert.equal(decision.askedQuestionText, "look at the customer's LTV before refunding");
    }
  }
});

test("computeReAskBlock — an open `asked` card takes precedence over ceiling (the founder's answer is the primary signal)", () => {
  // Even if the ceiling is met, an open asked card blocks first — its answer needs to be consumed
  // before a summary "asked N times" card is meaningful. The order matters: block the noise first,
  // let the consumer feed the answer back into the loop, then ceiling if it still hasn't landed.
  const decision = computeReAskBlock({
    openAskedCount: 2,
    askedQuestionText: "founder's lens",
    mintCountInWindow: JUNE_REASK_CEILING + 3,
  });
  assert.equal(decision.block, true);
  if (decision.block) assert.equal(decision.kind, "asked_open");
});

test("computeReAskBlock — mint count exceeds ceiling with NO asked card → block:ceiling (the safety valve)", () => {
  const decision = computeReAskBlock({
    openAskedCount: 0,
    askedQuestionText: null,
    mintCountInWindow: JUNE_REASK_CEILING,
  });
  assert.equal(decision.block, true);
  if (decision.block) {
    assert.equal(decision.kind, "ceiling");
    if (decision.kind === "ceiling") assert.equal(decision.mintCountInWindow, JUNE_REASK_CEILING);
  }
});

test("computeReAskBlock — mint count under ceiling with NO asked card → NO block (normal mint proceeds)", () => {
  const decision = computeReAskBlock({
    openAskedCount: 0,
    askedQuestionText: null,
    mintCountInWindow: JUNE_REASK_CEILING - 1,
  });
  assert.equal(decision.block, false);
});

test("computeReAskBlock — first-ever mint (zero counts, no asked) → NO block (the whole point is to not slow the happy path)", () => {
  const decision = computeReAskBlock({
    openAskedCount: 0,
    askedQuestionText: null,
    mintCountInWindow: 0,
  });
  assert.equal(decision.block, false);
});

test("computeReAskBlock — asked card with NO question_text → block:asked_open with askedQuestionText:null (the mint site logs '(none recorded)')", () => {
  // Defensive path: an `asked` card WITHOUT a recorded question_text (a legacy row or a bug). The
  // block still fires — the answer's absence doesn't unblock the re-ask; it just means the caller's
  // internal note reads '(none recorded)' rather than the founder's text.
  const decision = computeReAskBlock({
    openAskedCount: 1,
    askedQuestionText: null,
    mintCountInWindow: 1,
  });
  assert.equal(decision.block, true);
  if (decision.block && decision.kind === "asked_open") {
    assert.equal(decision.askedQuestionText, null);
  }
});
