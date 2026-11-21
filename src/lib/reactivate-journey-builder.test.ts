/**
 * Pins `isReactivateChoice`: the win-back "Yes, restart" click must restart the sub even though the
 * code-driven journey page posts outcome="completed" (not "reactivated") on its terminal step.
 *
 * Run: npx tsx --test src/lib/reactivate-journey-builder.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReactivateChoice } from "./reactivate-journey-builder";

test("explicit reactivated outcome restarts", () => {
  assert.equal(isReactivateChoice("reactivated", {}), true);
});

test("completed outcome + reactivate answer restarts (the page's real payload)", () => {
  assert.equal(isReactivateChoice("completed", { reactivate_choice: { value: "reactivate" } }), true);
});

test("not_now answer does not restart", () => {
  assert.equal(isReactivateChoice("completed", { reactivate_choice: { value: "not_now" } }), false);
});

test("unrelated journeys never restart", () => {
  assert.equal(isReactivateChoice("completed", { cancel_reason: { value: "overstock" } }), false);
  assert.equal(isReactivateChoice("cancelled", null), false);
  assert.equal(isReactivateChoice(undefined, undefined), false);
});
