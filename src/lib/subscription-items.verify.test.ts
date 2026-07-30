/**
 * Unit tests for the post-mutation verification predicate + polling loop
 * introduced in Phase 1 of
 * docs/brain/specs/a-subscription-mutation-must-verify-it-happened-not-trust-http-200.
 *
 * Pins the SPECIFIC failing state the spec exists to close: contracts
 * 27946909869 + 27871477933 on 2026-07-30, where a subAddItem then
 * subRemoveItem both returned {success:true} while the live contract still
 * showed Strawberry Lemonade on both. `checkAppstleLineExpectation`
 * (remove-kind) must return `met:false` when the variant is still present,
 * and `verifyContractEndState` must return `verified:false` on timeout.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.verify.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkAppstleLineExpectation,
  verifyContractEndState,
  type ContractLineForVerify,
} from "./subscription-items";

// The Strawberry Lemonade line the two known-bad contracts still carried
// after a false-success remove call (spec § Phase 1, 2026-07-30 repro).
const STRAWBERRY_LEMONADE_LINE: ContractLineForVerify = {
  variantId: "gid://shopify/ProductVariant/44112233445",
  quantity: 1,
  currentPrice: { amount: "29.96" },
};

const CHERRY_LIME_LINE: ContractLineForVerify = {
  variantId: "gid://shopify/ProductVariant/55223344556",
  quantity: 1,
  currentPrice: { amount: "29.96" },
};

test("named failing state: remove returned 200 but Strawberry Lemonade still on contract → not met", () => {
  const r = checkAppstleLineExpectation([STRAWBERRY_LEMONADE_LINE], {
    kind: "remove",
    variantId: "44112233445",
  });
  assert.equal(r.met, false);
  if (r.met === false) {
    assert.match(r.observed, /still present/);
  }
});

test("remove: the variant is genuinely absent → met", () => {
  const r = checkAppstleLineExpectation([CHERRY_LIME_LINE], {
    kind: "remove",
    variantId: "44112233445",
  });
  assert.equal(r.met, true);
});

test("add: variant present at intended qty → met", () => {
  const r = checkAppstleLineExpectation(
    [{ variantId: "gid://shopify/ProductVariant/99", quantity: 2 }],
    { kind: "add", variantId: "99", quantity: 2 },
  );
  assert.equal(r.met, true);
});

test("add: variant absent → not met (the 27871477933 repro shape)", () => {
  const r = checkAppstleLineExpectation([STRAWBERRY_LEMONADE_LINE], {
    kind: "add",
    variantId: "99",
    quantity: 1,
  });
  assert.equal(r.met, false);
  if (r.met === false) assert.match(r.observed, /not present/);
});

test("add: variant present at wrong quantity → not met, observed qty called out", () => {
  const r = checkAppstleLineExpectation(
    [{ variantId: "gid://shopify/ProductVariant/99", quantity: 1 }],
    { kind: "add", variantId: "99", quantity: 3 },
  );
  assert.equal(r.met, false);
  if (r.met === false) {
    assert.match(r.observed, /qty 1/);
    assert.match(r.observed, /expected 3/);
  }
});

test("swap: old absent AND new present at qty → met", () => {
  const r = checkAppstleLineExpectation([CHERRY_LIME_LINE], {
    kind: "swap",
    oldVariantId: "44112233445",
    newVariantId: "55223344556",
    quantity: 1,
  });
  assert.equal(r.met, true);
});

test("swap: old STILL present → not met (the 2026-07-30 Strawberry Lemonade case)", () => {
  const r = checkAppstleLineExpectation(
    [STRAWBERRY_LEMONADE_LINE, CHERRY_LIME_LINE],
    { kind: "swap", oldVariantId: "44112233445", newVariantId: "55223344556", quantity: 1 },
  );
  assert.equal(r.met, false);
  if (r.met === false) assert.match(r.observed, /old variant 44112233445 still present/);
});

test("swap: new variant absent → not met", () => {
  const r = checkAppstleLineExpectation([], {
    kind: "swap",
    oldVariantId: "44112233445",
    newVariantId: "55223344556",
    quantity: 1,
  });
  assert.equal(r.met, false);
  if (r.met === false) assert.match(r.observed, /new variant 55223344556 not present/);
});

test("changeQuantity: matching qty → met; mismatched qty → not met", () => {
  const line: ContractLineForVerify = { variantId: "gid://shopify/ProductVariant/77", quantity: 4 };
  assert.equal(
    checkAppstleLineExpectation([line], { kind: "changeQuantity", variantId: "77", quantity: 4 }).met,
    true,
  );
  const r = checkAppstleLineExpectation([line], { kind: "changeQuantity", variantId: "77", quantity: 2 });
  assert.equal(r.met, false);
  if (r.met === false) assert.match(r.observed, /qty 4/);
});

test("priceUpdate: currentPrice matches base*0.75 → met", () => {
  // base $69.95 → currentPrice $52.46 after the 25% S&S cycle
  const line: ContractLineForVerify = {
    variantId: "gid://shopify/ProductVariant/88",
    quantity: 1,
    currentPrice: { amount: "52.46" },
  };
  const r = checkAppstleLineExpectation([line], {
    kind: "priceUpdate",
    variantId: "88",
    basePriceCents: 6995,
  });
  assert.equal(r.met, true);
});

test("priceUpdate: basePrice on the line matches → met (even if currentPrice omitted)", () => {
  const line: ContractLineForVerify = {
    variantId: "gid://shopify/ProductVariant/88",
    quantity: 1,
    basePrice: "69.95",
    currentPrice: null,
  };
  const r = checkAppstleLineExpectation([line], {
    kind: "priceUpdate",
    variantId: "88",
    basePriceCents: 6995,
  });
  assert.equal(r.met, true);
});

test("priceUpdate: neither basePrice nor currentPrice matches → not met", () => {
  const line: ContractLineForVerify = {
    variantId: "gid://shopify/ProductVariant/88",
    quantity: 1,
    basePrice: "79.95",
    currentPrice: { amount: "59.96" },
  };
  const r = checkAppstleLineExpectation([line], {
    kind: "priceUpdate",
    variantId: "88",
    basePriceCents: 6995,
  });
  assert.equal(r.met, false);
  if (r.met === false) assert.match(r.observed, /variant 88/);
});

test("verifyContractEndState: timeout — false success on remove ends as FAILURE not assumed success", async () => {
  // Simulated Appstle: contract always still shows Strawberry Lemonade. The
  // polling loop hits its deadline; the mutation must be classified as failed
  // so a caller retries or escalates, never as "done".
  let calls = 0;
  const r = await verifyContractEndState("fake-key", "27946909869", {
    kind: "remove",
    variantId: "44112233445",
  }, {
    timeoutMs: 50,
    pollIntervalMs: 10,
    fetchLines: async () => {
      calls++;
      return [STRAWBERRY_LEMONADE_LINE];
    },
  });
  assert.equal(r.verified, false);
  assert.ok(calls >= 1, "should have polled at least once");
  if (r.verified === false) {
    assert.match(r.error, /Verification failed/);
    assert.match(r.error, /still present/);
  }
});

test("verifyContractEndState: succeeds as soon as Appstle finishes applying (settle window)", async () => {
  // First poll: Appstle hasn't applied yet (variant still there). Second poll:
  // applied — the bounded settle window covers the async apply.
  let call = 0;
  const r = await verifyContractEndState("fake-key", "27946909869", {
    kind: "remove",
    variantId: "44112233445",
  }, {
    timeoutMs: 200,
    pollIntervalMs: 5,
    fetchLines: async () => {
      call++;
      return call === 1 ? [STRAWBERRY_LEMONADE_LINE] : [];
    },
  });
  assert.equal(r.verified, true);
});

test("verifyContractEndState: contract fetch failure across the whole window → FAILURE (unverifiable is not done)", async () => {
  const r = await verifyContractEndState("fake-key", "27946909869", {
    kind: "add",
    variantId: "99",
    quantity: 1,
  }, {
    timeoutMs: 30,
    pollIntervalMs: 5,
    fetchLines: async () => null,
  });
  assert.equal(r.verified, false);
  if (r.verified === false) {
    assert.match(r.error, /Verification failed/);
    assert.match(r.error, /contract fetch failed/);
  }
});
