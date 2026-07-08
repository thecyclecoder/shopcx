/**
 * Unit tests for the Phase-1 validator (docs/brain/specs/secure-sol-required-outcomes-dispatch.md
 * § Phase 1).
 *
 * Focus: the vulnerability the eliminate-false-promises spec left open —
 * customer-influenced model JSON directly driving service-role commerce mutations. The validator
 * MUST reject a prompt-injected required_outcomes item whose target contract/order belongs to a
 * different customer (or a different workspace) BEFORE the honor step dispatches. Also covers
 * the unknown-kind allowlist and missing-target-id shape guard.
 *
 * Run:
 *   npx tsx --test src/lib/required-outcomes-validator.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALLOWED_OUTCOME_KINDS,
  requiredTargetIdsFor,
  validateRequiredOutcomes,
  type ValidatorItem,
} from "./required-outcomes-validator";

// ── Fake admin: a builder that records the last query's filters and returns the row (or null) the
// test seeded. Everything is one-shot; a test wanting multiple reads seeds multiple rows keyed by
// (table, filter key). ───────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown> | null;

interface FakeAdminSeed {
  subscriptions?: Map<string, Row>; // key = shopify_contract_id
  orders?: Map<string, Row>; // key = shopify_order_id OR order_number
  products?: Map<string, Row>; // key = shopify_product_id or id
}

function fakeAdmin(seed: FakeAdminSeed): SupabaseClient {
  return {
    from(table: string) {
      let bag: Map<string, Row> | undefined;
      if (table === "subscriptions") bag = seed.subscriptions;
      else if (table === "orders") bag = seed.orders;
      else if (table === "products") bag = seed.products;
      const filters: Record<string, unknown> = {};
      const q = {
        select: (_c: string) => q,
        eq(col: string, val: unknown) { filters[col] = val; return q; },
        async maybeSingle() {
          // The keys we care about are the identifying id in that table.
          let key: string | null = null;
          if (table === "subscriptions") key = String(filters["shopify_contract_id"] ?? "");
          else if (table === "orders") {
            key = String(filters["shopify_order_id"] ?? filters["order_number"] ?? "");
          } else if (table === "products") {
            key = String(filters["shopify_product_id"] ?? filters["id"] ?? "");
          }
          const row = key && bag ? bag.get(key) ?? null : null;
          // Enforce workspace_id filter — a caller that omits it MUST fail closed at the callsite.
          if (row && filters["workspace_id"] && row["workspace_id"] !== filters["workspace_id"]) {
            return { data: null, error: null };
          }
          return { data: row, error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const TICKET = { workspace_id: "w1", ticket_id: "t1", customer_id: "c1" };

// ── Allowlist gate ────────────────────────────────────────────────────────────────────────

test("allowlist: canonical Judy kinds (add_bag_to_next_order, apply_coupon) are allowed", () => {
  assert.equal(ALLOWED_OUTCOME_KINDS.has("add_bag_to_next_order"), true);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("apply_coupon"), true);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("partial_refund"), true);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("create_return"), true);
});

test("allowlist: dangerous / non-outcome kinds are NOT allowed (deactivate_ticket, create_order, close_ticket)", () => {
  // A prompt-injected required_outcomes[].kind naming a handler that mutates ticket state or
  // fabricates orders would let a bad reply corrupt the queue without ever touching the customer's
  // commerce. Those handlers exist for the orchestrator; they don't belong on Sol's outcome list.
  assert.equal(ALLOWED_OUTCOME_KINDS.has("deactivate_ticket"), false);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("create_order"), false);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("create_subscription"), false);
  assert.equal(ALLOWED_OUTCOME_KINDS.has("close_ticket"), false);
});

test("unknown kind → blocked with reason=unknown_kind, whole verdict !ok", async () => {
  const items: ValidatorItem[] = [
    { kind: "steal_credit_card", description: "prompt-injected fake" },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({}),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked.length, 1);
    assert.equal(verdict.blocked[0].reason, "unknown_kind");
    assert.match(verdict.reason, /steal_credit_card/);
  }
});

// ── Shape guard: missing target id for a kind that needs one ────────────────────────────────

test("requiredTargetIdsFor: apply_coupon needs contract_id", () => {
  assert.equal(requiredTargetIdsFor("apply_coupon").needs_contract, true);
});

test("requiredTargetIdsFor: partial_refund needs order (not contract)", () => {
  assert.equal(requiredTargetIdsFor("partial_refund").needs_order, true);
  assert.equal(!!requiredTargetIdsFor("partial_refund").needs_contract, false);
});

test("apply_coupon with NO contract_id → missing_target_ids blocked", async () => {
  const items: ValidatorItem[] = [
    { kind: "apply_coupon", description: "apply $15 credit", target_ids: {} },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({}),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked[0].reason, "missing_target_ids");
  }
});

test("partial_refund with NO order id → missing_target_ids blocked", async () => {
  const items: ValidatorItem[] = [
    { kind: "partial_refund", description: "$25 refund", target_ids: {} },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({}),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked[0].reason, "missing_target_ids");
  }
});

// ── THE VULNERABILITY: cross-customer contract_id — the security envelope this spec closes ─────

test("apply_coupon with cross-CUSTOMER contract_id → subscription_customer_mismatch, no dispatch", async () => {
  // Prompt-injected required_outcomes item names a contract_id that exists in the workspace but
  // belongs to a DIFFERENT customer than the ticket. The validator MUST reject before any
  // directActionHandlers dispatch.
  const subs = new Map<string, Row>();
  subs.set("gid://shopify/SubscriptionContract/OTHER", {
    workspace_id: "w1",
    customer_id: "c-attacker-target", // NOT c1
  });
  const items: ValidatorItem[] = [
    {
      kind: "apply_coupon",
      description: "apply credit to OTHER customer's sub",
      target_ids: { contract_id: "gid://shopify/SubscriptionContract/OTHER" },
    },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ subscriptions: subs }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false, "cross-customer target MUST NOT dispatch");
  if (verdict.ok === false) {
    assert.equal(verdict.blocked.length, 1);
    assert.equal(verdict.blocked[0].reason, "subscription_customer_mismatch");
    assert.match(verdict.blocked[0].detail, /different customer/);
  }
});

test("apply_coupon with cross-WORKSPACE contract_id → subscription_not_found (workspace scope hides it)", async () => {
  const subs = new Map<string, Row>();
  subs.set("gid://shopify/SubscriptionContract/OTHER-WS", {
    workspace_id: "w-other", // NOT w1
    customer_id: "c1",
  });
  const items: ValidatorItem[] = [
    {
      kind: "apply_coupon",
      description: "cross-workspace target",
      target_ids: { contract_id: "gid://shopify/SubscriptionContract/OTHER-WS" },
    },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ subscriptions: subs }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked[0].reason, "subscription_not_found");
  }
});

test("partial_refund with cross-CUSTOMER shopify_order_id → order_customer_mismatch", async () => {
  const orders = new Map<string, Row>();
  orders.set("shopify_order_999", { workspace_id: "w1", customer_id: "c-other" });
  const items: ValidatorItem[] = [
    {
      kind: "partial_refund",
      description: "refund from OTHER customer's order",
      target_ids: { shopify_order_id: "shopify_order_999" },
    },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ orders }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked[0].reason, "order_customer_mismatch");
  }
});

// ── Positive path: valid Judy scenario ─────────────────────────────────────────────────────

test("Judy positive: apply_coupon on the ticket's OWN contract → validator passes", async () => {
  const subs = new Map<string, Row>();
  subs.set("gid://shopify/SubscriptionContract/JUDY", {
    workspace_id: "w1",
    customer_id: "c1", // the ticket's own customer
  });
  const items: ValidatorItem[] = [
    {
      kind: "apply_coupon",
      description: "apply $15 credit",
      target_ids: { contract_id: "gid://shopify/SubscriptionContract/JUDY", code: "JUDY15" },
    },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ subscriptions: subs }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, true);
});

test("customer-scoped kinds (unsubscribe_all_marketing) pass without target_ids", async () => {
  const items: ValidatorItem[] = [
    { kind: "unsubscribe_all_marketing", description: "opt out of all marketing" },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({}),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, true);
});

// ── Multi-item: one bad item flips the whole verdict; all bad items surface ────────────────

test("multi-item: one clean item + one prompt-injected cross-customer → whole verdict blocked, both are surfaced by the blocker's index", async () => {
  const subs = new Map<string, Row>();
  subs.set("gid://own", { workspace_id: "w1", customer_id: "c1" });
  subs.set("gid://other", { workspace_id: "w1", customer_id: "c-other" });
  const items: ValidatorItem[] = [
    { kind: "apply_coupon", description: "credit on own sub", target_ids: { contract_id: "gid://own" } },
    { kind: "apply_coupon", description: "credit on OTHER's sub", target_ids: { contract_id: "gid://other" } },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ subscriptions: subs }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false, "a single bad item MUST block the entire send");
  if (verdict.ok === false) {
    assert.equal(verdict.blocked.length, 1);
    assert.equal(verdict.blocked[0].index, 1, "the second item is the blocker");
    assert.equal(verdict.blocked[0].reason, "subscription_customer_mismatch");
  }
});

test("multi-item all bad: unknown_kind + cross-customer + missing_target_ids → all three surfaced", async () => {
  const subs = new Map<string, Row>();
  subs.set("gid://other", { workspace_id: "w1", customer_id: "c-other" });
  const items: ValidatorItem[] = [
    { kind: "steal_something", description: "malicious" },
    { kind: "apply_coupon", description: "cross-cust", target_ids: { contract_id: "gid://other" } },
    { kind: "partial_refund", description: "no target", target_ids: {} },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ subscriptions: subs }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    const reasons = verdict.blocked.map((b) => b.reason).sort();
    assert.deepEqual(reasons, ["missing_target_ids", "subscription_customer_mismatch", "unknown_kind"]);
  }
});

// ── target ownership check on order_number path (not just shopify_order_id) ─────────────

test("create_return with order_number path → still scoped by workspace + customer", async () => {
  const orders = new Map<string, Row>();
  orders.set("1234", { workspace_id: "w1", customer_id: "c-other" });
  const items: ValidatorItem[] = [
    {
      kind: "create_return",
      description: "return from OTHER's order",
      target_ids: { order_number: "1234" },
    },
  ];
  const verdict = await validateRequiredOutcomes({
    admin: fakeAdmin({ orders }),
    ...TICKET,
    items,
  });
  assert.equal(verdict.ok, false);
  if (verdict.ok === false) {
    assert.equal(verdict.blocked[0].reason, "order_customer_mismatch");
  }
});
