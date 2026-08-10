/**
 * Unit tests for verifyActionInDB's remove_coupon case + the pure
 * stillHasDiscountCode helper behind it.
 *
 * Load-bearing: pre-fix, `verifyActionInDB` had no case for `remove_coupon`
 * and the switch hit `console.warn(uncovered action type — assuming OK:
 * remove_coupon)` (observed 2026-08-10, Randi Stier ticket
 * c2bc8bd8-2aca-4eeb-968b-dd968a3d0dbc), letting a silent no-op remover
 * ship an "I removed it" message onward. Phase 2 wires an executor-level
 * read-back that fails the action when the code is still present under any
 * stored shape (bare string · {title} · {code} · {id}), so the false
 * success cannot pass even if a future variant of the shape mismatch
 * re-emerges.
 *
 * Pure — no live DB. Uses the same in-memory fake-admin pattern as
 * action-executor.verify-in-db.test.ts. Run:
 *   npx tsx --test src/lib/action-executor.verify-remove-coupon.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyActionInDB,
  stillHasDiscountCode,
  type ActionParams,
} from "./action-executor";

// ── Pure predicate ────────────────────────────────────────────────────

test("stillHasDiscountCode: {title} shape (the one internalSubApplyDiscount writes)", () => {
  assert.equal(stillHasDiscountCode([{ title: "PROMO20" }], "PROMO20"), true);
  assert.equal(stillHasDiscountCode([{ title: "OTHER" }], "PROMO20"), false);
});

test("stillHasDiscountCode: {code} shape (the one internal_subscription_renewal rewrites the row to — Randi Stier)", () => {
  assert.equal(
    stillHasDiscountCode([{ code: "PROMO20", value: 20, valueType: "percentage" }], "PROMO20"),
    true,
  );
});

test("stillHasDiscountCode: {id} shape (the discount-node id shape Appstle mirrors)", () => {
  assert.equal(
    stillHasDiscountCode([{ id: "gid://shopify/DiscountCodeNode/123" }], "gid://shopify/DiscountCodeNode/123"),
    true,
  );
});

test("stillHasDiscountCode: bare-string shape", () => {
  assert.equal(stillHasDiscountCode(["PROMO20"], "PROMO20"), true);
  assert.equal(stillHasDiscountCode(["OTHER"], "PROMO20"), false);
});

test("stillHasDiscountCode: case-insensitive (resolveCoupon returns caller casing)", () => {
  assert.equal(stillHasDiscountCode([{ code: "promo20" }], "PROMO20"), true);
  assert.equal(stillHasDiscountCode([{ title: "PROMO20" }], "promo20"), true);
});

test("stillHasDiscountCode: empty / non-array → false (no coupon to still-have)", () => {
  assert.equal(stillHasDiscountCode([], "PROMO20"), false);
  assert.equal(stillHasDiscountCode(null, "PROMO20"), false);
  assert.equal(stillHasDiscountCode(undefined, "PROMO20"), false);
  assert.equal(stillHasDiscountCode({} as unknown, "PROMO20"), false);
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
const params = (code: string): ActionParams =>
  ({ type: "remove_coupon", contract_id: CONTRACT, code } as unknown as ActionParams);

test("remove_coupon: applied_discounts empty → verified TRUE (removal landed)", async () => {
  const ctx = makeCtx({
    subscriptions: [{ shopify_contract_id: CONTRACT, applied_discounts: [] }],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), true);
});

test("remove_coupon: code STILL PRESENT under {title} → verified FALSE (false success caught)", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ title: "PROMO20" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), false);
});

test("remove_coupon: code STILL PRESENT under {code} (the renewal-rewritten shape) → verified FALSE — the Randi Stier bug", async () => {
  const ctx = makeCtx({
    subscriptions: [
      {
        shopify_contract_id: CONTRACT,
        applied_discounts: [{ code: "PROMO20", value: 20, valueType: "percentage" }],
      },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), false);
});

test("remove_coupon: code STILL PRESENT under {id} → verified FALSE", async () => {
  const CODE = "gid://shopify/DiscountCodeNode/123";
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ id: CODE }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params(CODE)), false);
});

test("remove_coupon: code STILL PRESENT as bare string → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: ["PROMO20"] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), false);
});

test("remove_coupon: case-insensitive re-read (stored 'promo20', requested 'PROMO20') → verified FALSE", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ code: "promo20" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), false);
});

test("remove_coupon: other code still on the sub is IGNORED — only target code presence fails the verify", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ title: "KEEP-ME" }] },
    ],
  });
  assert.equal(await verifyActionInDB(ctx, params("PROMO20")), true);
});

test("remove_coupon: missing contract_id → verified TRUE (nothing to check — mirrors sibling coupon case)", async () => {
  const ctx = makeCtx({ subscriptions: [] });
  const action = { type: "remove_coupon", code: "PROMO20" } as unknown as ActionParams;
  assert.equal(await verifyActionInDB(ctx, action), true);
});

test("remove_coupon: coupon_code alias is honored (some emitters use coupon_code, not code)", async () => {
  const ctx = makeCtx({
    subscriptions: [
      { shopify_contract_id: CONTRACT, applied_discounts: [{ code: "PROMO20" }] },
    ],
  });
  const action = {
    type: "remove_coupon",
    contract_id: CONTRACT,
    coupon_code: "PROMO20",
  } as unknown as ActionParams;
  assert.equal(await verifyActionInDB(ctx, action), false);
});
