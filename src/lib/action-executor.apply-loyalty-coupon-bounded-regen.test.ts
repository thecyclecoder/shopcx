/**
 * Phase-2 tests for the `apply_loyalty_coupon` regen self-heal (spec:
 * loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen).
 *
 * Locked in here:
 *   1. `MAX_LOYALTY_REGEN_ATTEMPTS` exists as a bounded ceiling — a
 *      persistently-rejecting upstream cannot loop indefinitely inside the
 *      regen branch (spec verification bar: "a bounded regen-attempt
 *      ceiling exists").
 *   2. `resolveContractOwnerShopifyCustomerId` resolves the target
 *      contract's owning Shopify customer id (subscriptions.customer_id →
 *      customers.shopify_customer_id) so the regen mint's
 *      `customerSelection.customers.add` targets the customer that CAN
 *      actually apply the code — not the aggregate-canonical member (which
 *      may be a linked sibling holding the higher points balance).
 *   3. `verifyLoyaltyCouponAppliedToContract` re-reads the sub's
 *      `applied_discounts` before we report the apply succeeded — Shopify's
 *      "success" is not the same as the code actually being on the contract
 *      (Sandra Lutz precedent; ticket 2b7ea029).
 *
 * Pure — no live DB, no live Shopify. Uses an in-memory admin fake shaped
 * like supabase-js — mirrors action-executor.atomic-redeem-apply.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.apply-loyalty-coupon-bounded-regen.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LOYALTY_REGEN_ATTEMPTS,
  resolveContractOwnerShopifyCustomerId,
  verifyLoyaltyCouponAppliedToContract,
} from "./action-executor";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter { col: string; val: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) if (row[f.col] !== f.val) return false;
  return true;
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
    eq: (col, val) => { filters.push({ col, val }); return chain },
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return { from: (t: string) => makeChain(tables, t) } as unknown as
    Parameters<typeof resolveContractOwnerShopifyCustomerId>[0];
}

// ─── Bounded-ceiling constant (spec verification bar) ────────────────

test("MAX_LOYALTY_REGEN_ATTEMPTS is a finite positive integer — the regen branch cannot loop indefinitely", () => {
  assert.equal(typeof MAX_LOYALTY_REGEN_ATTEMPTS, "number");
  assert.ok(Number.isInteger(MAX_LOYALTY_REGEN_ATTEMPTS), "ceiling must be an integer");
  assert.ok(MAX_LOYALTY_REGEN_ATTEMPTS >= 1, "at least one apply attempt");
  assert.ok(MAX_LOYALTY_REGEN_ATTEMPTS <= 10, "bounded — a runaway ceiling defeats the point of adding one");
});

// ─── resolveContractOwnerShopifyCustomerId ───────────────────────────

test("resolveContractOwnerShopifyCustomerId: subscriptions.customer_id → customers.shopify_customer_id", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      customer_id: "uuid-gmail",
    }],
    customers: [{ id: "uuid-gmail", shopify_customer_id: "shopify-cust-GMAIL" }],
  };
  const got = await resolveContractOwnerShopifyCustomerId(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999");
  assert.equal(got, "shopify-cust-GMAIL", "regen mint must target this Shopify id, not the aggregate member's");
});

test("resolveContractOwnerShopifyCustomerId: sub row missing → null (regen falls back to member.shopify_customer_id)", async () => {
  const got = await resolveContractOwnerShopifyCustomerId(makeAdmin({}), "ws-1", "gid://shopify/SubscriptionContract/absent");
  assert.equal(got, null);
});

test("resolveContractOwnerShopifyCustomerId: customer row missing shopify_customer_id → null (unknown provenance)", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      customer_id: "uuid-gmail",
    }],
    customers: [{ id: "uuid-gmail", shopify_customer_id: null }],
  };
  const got = await resolveContractOwnerShopifyCustomerId(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999");
  assert.equal(got, null);
});

test("resolveContractOwnerShopifyCustomerId: cross-workspace sub row does NOT leak (workspace_id predicate)", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-OTHER",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      customer_id: "uuid-gmail",
    }],
    customers: [{ id: "uuid-gmail", shopify_customer_id: "shopify-cust-GMAIL" }],
  };
  const got = await resolveContractOwnerShopifyCustomerId(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999");
  assert.equal(got, null, "sub belongs to a different tenant — never leak");
});

// ─── verifyLoyaltyCouponAppliedToContract ────────────────────────────

test("verifyLoyaltyCouponAppliedToContract: code present in applied_discounts as bare string → true", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      applied_discounts: ["LOYALTY-15-NEWABC"],
    }],
  };
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-NEWABC");
  assert.equal(got, true);
});

test("verifyLoyaltyCouponAppliedToContract: code present as {title: 'Loyalty $15 (LOYALTY-15-NEWABC)'} → true", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      applied_discounts: [{ title: "Loyalty $15 (LOYALTY-15-NEWABC)" }],
    }],
  };
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-NEWABC");
  assert.equal(got, true, "matches on tolerant title/code shape family — same as subscriptionHasLoyaltyCoupon");
});

test("verifyLoyaltyCouponAppliedToContract: applied_discounts empty → false (apply-reported-success but code didn't land)", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      applied_discounts: [],
    }],
  };
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-NEWABC");
  assert.equal(got, false, "Sandra Lutz safety net — 'success' without presence is not success");
});

test("verifyLoyaltyCouponAppliedToContract: sub row missing → false (unknown treated as didn't land)", async () => {
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin({}), "ws-1", "gid://shopify/SubscriptionContract/absent", "LOYALTY-15-NEWABC");
  assert.equal(got, false);
});

test("verifyLoyaltyCouponAppliedToContract: case-insensitive match (Shopify may normalize case)", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      applied_discounts: ["loyalty-15-newabc"],
    }],
  };
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-NEWABC");
  assert.equal(got, true);
});

test("verifyLoyaltyCouponAppliedToContract: an OTHER coupon on the sub does not falsely match this code", async () => {
  const tables: Tables = {
    subscriptions: [{
      workspace_id: "ws-1",
      shopify_contract_id: "gid://shopify/SubscriptionContract/999",
      applied_discounts: [{ code: "SUMMER25" }, { title: "Loyalty $10 (LOYALTY-10-DIFFXX)" }],
    }],
  };
  const got = await verifyLoyaltyCouponAppliedToContract(makeAdmin(tables), "ws-1", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-NEWABC");
  assert.equal(got, false);
});
