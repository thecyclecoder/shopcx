/**
 * Unit tests for Phase-2 (ticket-merge-summary-and-context-cap) helpers in
 * src/lib/sonnet-orchestrator-v2.ts. Pure — no network, no DB. Run:
 *   npx tsx --test src/lib/sonnet-orchestrator-v2-merge-summary.test.ts
 *
 * Named failing state (spec Phase-2 verification): "After K new messages
 * the tail is folded in and merge_summary_at advances." The rollup
 * predicate must fire on K messages OR T chars — otherwise a merged
 * ticket's tail grows unbounded and the whole "since window stays small
 * and prefix stays stable" invariant collapses back into the recost loop
 * this phase exists to kill.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldRollupTail,
  renderMergeSummaryPrefix,
  MERGE_TAIL_ROLLUP_K_MESSAGES,
  MERGE_TAIL_ROLLUP_T_CHARS,
} from "./sonnet-orchestrator-v2";

test("tail below both thresholds → no rollup", () => {
  assert.equal(shouldRollupTail(3, 1200), false);
  assert.equal(shouldRollupTail(0, 0), false);
});

test("tail at K messages → rollup fires (named failing state — tail must be folded in)", () => {
  assert.equal(shouldRollupTail(MERGE_TAIL_ROLLUP_K_MESSAGES, 100), true);
});

test("tail past T chars but few messages → rollup still fires (protects against burst)", () => {
  assert.equal(shouldRollupTail(4, MERGE_TAIL_ROLLUP_T_CHARS + 1), true);
});

test("both thresholds crossed → rollup fires", () => {
  assert.equal(
    shouldRollupTail(MERGE_TAIL_ROLLUP_K_MESSAGES + 5, MERGE_TAIL_ROLLUP_T_CHARS + 500),
    true,
  );
});

test("prefix carries lock timestamp + summary body verbatim + since-window marker", () => {
  const prefix = renderMergeSummaryPrefix(
    "Customer address = Kirkland; refund of $42 issued; awaiting shipping confirmation.",
    "2026-07-07T12:34:56Z",
  );
  assert.match(prefix, /2026-07-07T12:34:56Z/, "lock timestamp must appear in the prefix");
  assert.match(prefix, /address = Kirkland/);
  assert.match(prefix, /refund of \$42 issued/);
  assert.match(prefix, /conversation SINCE that lock-in/, "must mark the boundary so Sonnet reads state from prefix, chat from tail");
});
