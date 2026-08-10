/**
 * Unit tests for filterOutDiscount — the pure filter behind
 * internalSubRemoveDiscount. Covers every stored shape that has landed in
 * subscriptions.applied_discounts (bare string · {title} · {code} · {id}) so
 * the remover cannot silently no-op on a subscription that has billed at
 * least once (the {code} shape is what internal_subscription_renewal writes;
 * the pre-fix filter recognised only {title}/{id} and returned success
 * unconditionally, which discounted every subsequent renewal).
 *
 * Run:
 *   npx tsx --test src/lib/internal-subscription.removeDiscount.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { filterOutDiscount } from "./internal-subscription";

test("removes a {title} entry (the shape internalSubApplyDiscount writes)", () => {
  const { next, removed } = filterOutDiscount(
    [{ title: "PROMO20" }, { title: "KEEP-ME" }],
    "PROMO20",
  );
  assert.equal(removed, true);
  assert.deepEqual(next, [{ title: "KEEP-ME" }]);
});

test("removes a {code} entry (the shape a renewal rewrites the row to — Randi Stier 2026-08-10)", () => {
  const { next, removed } = filterOutDiscount(
    [{ code: "PROMO20", value: 20, valueType: "percentage" }],
    "PROMO20",
  );
  assert.equal(removed, true);
  assert.deepEqual(next, []);
});

test("removes an {id} entry (the discount-node id shape Appstle mirrors)", () => {
  const { next, removed } = filterOutDiscount(
    [{ id: "gid://shopify/DiscountCodeNode/123", title: "Old label" }],
    "gid://shopify/DiscountCodeNode/123",
  );
  assert.equal(removed, true);
  assert.deepEqual(next, []);
});

test("removes a bare-string entry (the shape loyalty tests already exercise)", () => {
  const { next, removed } = filterOutDiscount(["PROMO20", "KEEP-ME"], "PROMO20");
  assert.equal(removed, true);
  assert.deepEqual(next, [{ title: "KEEP-ME" }]);
});

test("case-insensitive match — resolveCoupon returns the caller's casing", () => {
  const { next, removed } = filterOutDiscount(
    [{ code: "promo20" }],
    "PROMO20",
  );
  assert.equal(removed, true);
  assert.deepEqual(next, []);
});

test("absent code → removed:false, unchanged next (caller reports failure honestly)", () => {
  const input = [{ title: "OTHER-CODE" }];
  const { next, removed } = filterOutDiscount(input, "PROMO20");
  assert.equal(removed, false);
  assert.deepEqual(next, input);
});

test("empty / non-array applied_discounts → removed:false, empty next", () => {
  assert.deepEqual(filterOutDiscount(null, "PROMO20"), { next: [], removed: false });
  assert.deepEqual(filterOutDiscount(undefined, "PROMO20"), { next: [], removed: false });
  assert.deepEqual(filterOutDiscount([], "PROMO20"), { next: [], removed: false });
});

test("mixed shapes in one blob — every matching form drops, non-matching stays", () => {
  const { next, removed } = filterOutDiscount(
    [
      { title: "PROMO20" },
      { code: "promo20" },
      { id: "PROMO20" },
      "PROMO20",
      { title: "KEEP-ME" },
      "OTHER",
    ],
    "PROMO20",
  );
  assert.equal(removed, true);
  assert.deepEqual(next, [{ title: "KEEP-ME" }, { title: "OTHER" }]);
});
