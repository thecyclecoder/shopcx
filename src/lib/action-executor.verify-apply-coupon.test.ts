/**
 * Unit tests for verifyActionInDB's apply_coupon / apply_loyalty_coupon case
 * + the shared shape-tolerant hasDiscountCode helper behind it.
 *
 * Load-bearing: pre-fix, the apply-side verify was `discounts.some(d =>
 * d.title === action.code)` — matched only the `{title}` shape. Internal
 * subscriptions write the `{code}` shape (that `computeAppliedDiscountCents`
 * honors), so a coupon that WAS correctly applied verified as failed, the
 * outcome-completion gate blocked auto-close, and the resolved ticket
 * false-escalated to a human (Janelle Heath 2026-08, ticket
 * `715658b5-934e-4ec8-937f-6ea749e8d3ea` — $10 LOYALTY-10-Z2XRVP genuinely
 * applied to K-Cups sub `internal-e392298b48834705` yet escalated as
 * `apply_loyalty_coupon[failed]`). The fix routes the apply-side verify
 * through the same shape-tolerant matcher the remove-side already uses —
 * bare string · `{title}` · `{code}` · `{id}`, case-insensitive — so a
 * genuinely-applied coupon verifies true regardless of which shape the
 * internal-sub write path settled on.
 *
 * Pure — no live DB. Uses the same in-memory fake-admin pattern as
 * action-executor.verify-remove-coupon.test.ts. Run:
 *   npx tsx --test src/lib/action-executor.verify-apply-coupon.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyActionInDB,
  hasDiscountCode,
  stillHasDiscountCode,
  type ActionParams,
} from "./action-executor";

// ── Pure predicate ────────────────────────────────────────────────────

test("hasDiscountCode: {title} shape (what internalSubApplyDiscount writes)", () => {
  assert.equal(hasDiscountCode([{ title: "PROMO20" }], "PROMO20"), true);
  assert.equal(hasDiscountCode([{ title: "OTHER" }], "PROMO20"), false);
});

test("hasDiscountCode: {code} shape (what internal_subscription_renewal rewrites — Janelle Heath)", () => {
  assert.equal(
    hasDiscountCode([{ code: "LOYALTY-10-Z2XRVP", value: 10, valueType: "fixed_amount" }], "LOYALTY-10-Z2XRVP"),
    true,
  );
});

test("hasDiscountCode: {id} shape (the discount-node id Appstle mirrors)", () => {
  assert.equal(
    hasDiscountCode([{ id: "gid://shopify/DiscountCodeNode/123" }], "gid://shopify/DiscountCodeNode/123"),
    true,
  );
});

test("hasDiscountCode: bare-string shape", () => {
  assert.equal(hasDiscountCode(["PROMO20"], "PROMO20"), true);
  assert.equal(hasDiscountCode(["OTHER"], "PROMO20"), false);
});

test("hasDiscountCode: case-insensitive (resolveCoupon returns caller casing)", () => {
  assert.equal(hasDiscountCode([{ code: "promo20" }], "PROMO20"), true);
  assert.equal(hasDiscountCode([{ title: "PROMO20" }], "promo20"), true);
});

test("hasDiscountCode: empty / non-array → false", () => {
  assert.equal(hasDiscountCode([], "PROMO20"), false);
  assert.equal(hasDiscountCode(null, "PROMO20"), false);
  assert.equal(hasDiscountCode(undefined, "PROMO20"), false);
  assert.equal(hasDiscountCode({} as unknown, "PROMO20"), false);
});

test("stillHasDiscountCode is exported as a semantic alias for hasDiscountCode", () => {
  assert.equal(stillHasDiscountCode, hasDiscountCode);
});

// ── verifyActionInDB end-to-end (in-memory fake admin) ────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter { col: string; val: unknown }
function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => row[f.col] === f.val);
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => {
      filters.push({ col, val });
      return chain;
    },
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeCtx(tables: Tables) {
  const admin = {
    from(table: string) { return makeChain(tables, table); },
  } as unknown as Parameters<typeof verifyActionInDB>[0]["admin"];
  return { admin, ticketId: "ticket-1" };
}

const CONTRACT = "gid://shopify/SubscriptionContract/999";
const applyLoyalty = (code: string): ActionParams =>
  ({ type: "apply_loyalty_coupon", contract_id: CONTRACT, code } as unknown as ActionParams);
const applyCoupon = (code: string): ActionParams =>
  ({ type: "apply_coupon", contract_id: CONTRACT, code } as unknown as ActionParams);

test("apply_loyalty_coupon: code PRESENT under {code} shape → verified TRUE — the Janelle Heath fix", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        shopify_contract_id: CONTRACT,
        applied_discounts: [
          { code: "LOYALTY-10-Z2XRVP", value: 10, valueType: "fixed_amount" },
        ],
      },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("LOYALTY-10-Z2XRVP")), true);
});

test("apply_loyalty_coupon: code PRESENT under {title} shape → verified TRUE (pre-fix already worked)", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ title: "PROMO20" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("PROMO20")), true);
});

test("apply_loyalty_coupon: code PRESENT under {id} shape → verified TRUE", async () => {
  const CODE = "gid://shopify/DiscountCodeNode/123";
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ id: CODE }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty(CODE)), true);
});

test("apply_loyalty_coupon: code PRESENT as bare string → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: ["PROMO20"] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("PROMO20")), true);
});

test("apply_loyalty_coupon: case-insensitive (stored 'loyalty-10-z2xrvp', requested 'LOYALTY-10-Z2XRVP') → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ code: "loyalty-10-z2xrvp" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("LOYALTY-10-Z2XRVP")), true);
});

test("apply_loyalty_coupon: code NOT present (only a different code sits on the sub) → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ code: "OTHER-CODE" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("LOYALTY-10-Z2XRVP")), false);
});

test("apply_loyalty_coupon: applied_discounts empty → verified FALSE (apply did not land)", async () => {
  const ctx = makeCtx({
    subscriptions: [{ shopify_contract_id: CONTRACT, applied_discounts: [] }],
  });
  assert.equal(await verifyActionInDB(ctx, applyLoyalty("LOYALTY-10-Z2XRVP")), false);
});

test("apply_loyalty_coupon: missing contract_id → verified TRUE (nothing to check — mirrors remove_coupon sibling)", async () => {
  const ctx = makeCtx({ subscriptions: [] });
  const action = { type: "apply_loyalty_coupon", code: "PROMO20" } as unknown as ActionParams;
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("apply_coupon (non-loyalty alias): {code} shape → verified TRUE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ code: "SAVE15" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, applyCoupon("SAVE15")), true);
});
