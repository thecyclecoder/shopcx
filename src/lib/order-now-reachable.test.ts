/**
 * Order-now must be a REACHABLE action for Sol / the orchestrator — Phase 1 of
 * docs/brain/specs/order-now-reachable-to-sol-and-orchestrator-not-claimed-nonexistent.md.
 *
 * Derived from ticket 0a9e4d7f (Judy) where Sol offered to ship the customer's
 * order sooner, then reneged: "no bill_now action exists for non-emergency
 * requests." The capability is real (subscriptionOrderNow / orderNowByContract);
 * the LLM's natural-language name for it is "order_now" (the portal handler and
 * portal/mutation-guard.ts both use that name), and when the orchestrator emits
 * `order_now` it lands on the executor's "Unknown action type" silent-miss
 * branch. This test pins the fix: `order_now` is a real handler key, and the
 * selective-clarify irreversible gate covers it (money-charging action → gated
 * confirm-first, same as bill_now / partial_refund / cancel).
 *
 * Run: `npx tsx --test src/lib/order-now-reachable.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { directActionHandlers } from "./action-executor";
import {
  DEFAULT_IRREVERSIBLE_SET,
  shouldClarify,
  buildClarificationMessage,
} from "./selective-clarify";

test("order_now is registered in directActionHandlers (dispatchable, not Unknown action type)", () => {
  assert.equal(typeof directActionHandlers.order_now, "function");
});

test("order_now is in the irreversible set — selective-clarify covers it", () => {
  assert.ok(DEFAULT_IRREVERSIBLE_SET.has("order_now"));
});

test("low-confidence order_now triggers selective-clarify (confirm-first before charging)", () => {
  assert.equal(
    shouldClarify({ confidence: 0.5, actions: [{ type: "order_now" }] }),
    true,
  );
});

test("high-confidence order_now does NOT clarify (trust the model, same as bill_now)", () => {
  assert.equal(
    shouldClarify({ confidence: 0.9, actions: [{ type: "order_now" }] }),
    false,
  );
});

test("buildClarificationMessage names the charge for order_now (bill-your-next-order phrasing)", () => {
  const msg = buildClarificationMessage([{ type: "order_now" }]);
  assert.match(msg, /bill your next order now/);
});
