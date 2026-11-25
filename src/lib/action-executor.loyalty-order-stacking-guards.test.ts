/**
 * Order/sub-scoped loyalty-ceiling guards
 * (loyalty-remedy-hard-cap-15-no-cashout-makewhole-june-never-escalates Phase 2).
 *
 * Phase 1 caps a SINGLE redemption at $15. Phase 2 closes the two remaining
 * ways the ceiling could be exceeded by COMBINING otherwise-in-cap actions:
 *
 *   1. `hasLoyaltyCodeApplied` — refuse a loyalty cash refund on an order
 *      that already consumed a LOYALTY-* coupon at checkout (wired into
 *      `redeem_points_as_refund` right after the order lookup).
 *
 *   2. `subscriptionHasLoyaltyCoupon` — refuse a second LOYALTY-* coupon on
 *      a contract already carrying one (wired into `apply_loyalty_coupon`
 *      before the mint/apply path).
 *
 * Both predicates are tolerant of the shapes seen in the wild:
 *   - orders.discount_codes JSONB — array of {code, amount, type} rows from
 *     Shopify (see supabase/migrations/20260331000001_orders_discount_codes.sql)
 *   - subscriptions.applied_discounts JSONB — array of {title, ...} objects
 *     (see supabase/migrations/20260403400000_subscription_discounts.sql;
 *      projected via `.title` in src/lib/research/probes/subscription.ts)
 *
 *   npx tsx --test src/lib/action-executor.loyalty-order-stacking-guards.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  directActionHandlers,
  hasLoyaltyCodeApplied,
  subscriptionHasLoyaltyCoupon,
  subscriptionLoyaltyCouponCodes,
} from "./action-executor";

// ── hasLoyaltyCodeApplied ─────────────────────────────────────────────

test("hasLoyaltyCodeApplied: LOYALTY-* code in the order's discount_codes → TRUE (block the second loyalty benefit)", () => {
  assert.equal(
    hasLoyaltyCodeApplied([
      { code: "LOYALTY-15-ABC123", amount: 15, type: "fixed_amount" },
    ]),
    true,
  );
});

test("hasLoyaltyCodeApplied: legacy smile-* code (migrated Smile.io redemption) → TRUE", () => {
  assert.equal(
    hasLoyaltyCodeApplied([{ code: "smile-abc-15", amount: 15 }]),
    true,
  );
});

test("hasLoyaltyCodeApplied: only non-loyalty codes (WELCOME10, SUMMER-SALE) → FALSE (the loyalty refund is legitimate)", () => {
  assert.equal(
    hasLoyaltyCodeApplied([
      { code: "WELCOME10", amount: 5 },
      { code: "SUMMER-SALE", amount: 3 },
    ]),
    false,
  );
});

test("hasLoyaltyCodeApplied: empty array / null / undefined / missing column → FALSE (fail-open on a fresh order)", () => {
  assert.equal(hasLoyaltyCodeApplied([]), false);
  assert.equal(hasLoyaltyCodeApplied(null), false);
  assert.equal(hasLoyaltyCodeApplied(undefined), false);
});

test("hasLoyaltyCodeApplied: malformed shapes (non-array, non-string entries, missing code) never crash", () => {
  assert.equal(hasLoyaltyCodeApplied("LOYALTY-15-ABC"), false); // top-level string is not the shape
  assert.equal(hasLoyaltyCodeApplied({ code: "LOYALTY-15-ABC" }), false); // object not wrapped in array
  assert.equal(hasLoyaltyCodeApplied([42, null, { amount: 5 }]), false);
  assert.equal(hasLoyaltyCodeApplied([{ code: 12345 }]), false); // non-string code
});

test("hasLoyaltyCodeApplied: string-only entries (some feeds project only the code string) → TRUE for LOYALTY-*", () => {
  assert.equal(hasLoyaltyCodeApplied(["LOYALTY-15-XYZ"]), true);
  assert.equal(hasLoyaltyCodeApplied(["WELCOME10", "LOYALTY-10-QRS"]), true);
});

test("hasLoyaltyCodeApplied: case-insensitive on the LOYALTY- prefix", () => {
  assert.equal(hasLoyaltyCodeApplied([{ code: "loyalty-15-abc" }]), true);
});

// ── subscriptionHasLoyaltyCoupon ──────────────────────────────────────

test("subscriptionHasLoyaltyCoupon: a LOYALTY-* discount already attached → TRUE (block the stacking attempt)", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "LOYALTY-15-ABC123" }]),
    true,
  );
});

test("subscriptionHasLoyaltyCoupon: only a non-loyalty discount (SAVE10) → FALSE (the fresh apply is legitimate)", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "SAVE10" }, { title: "SUMMER" }]),
    false,
  );
});

test("subscriptionHasLoyaltyCoupon: no active discounts → FALSE", () => {
  assert.equal(subscriptionHasLoyaltyCoupon([]), false);
  assert.equal(subscriptionHasLoyaltyCoupon(null), false);
});

test("subscriptionHasLoyaltyCoupon: mixed shapes tolerated — `title` OR `code` OR bare string", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ code: "LOYALTY-15-QQ" }]),
    true,
  );
  assert.equal(subscriptionHasLoyaltyCoupon(["LOYALTY-15-QQ"]), true);
});

test("subscriptionHasLoyaltyCoupon: garbage entries never crash", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([null, 42, { title: null }, {}]),
    false,
  );
});

test("subscriptionHasLoyaltyCoupon: legacy smile-* discount → TRUE", () => {
  assert.equal(
    subscriptionHasLoyaltyCoupon([{ title: "smile-abc-15" }]),
    true,
  );
});

// ── Interaction pin: the two guards together close the combine-past-cap vector

test("Phase 2 invariant: an order carrying a $15 LOYALTY-* AND a sub carrying a $15 LOYALTY-* — both guards TRUE, both handlers must refuse", () => {
  const alreadyLoyaltyOrder = [
    { code: "LOYALTY-15-CHECKOUT", amount: 15, type: "fixed_amount" },
  ];
  const alreadyLoyaltySub = [{ title: "LOYALTY-15-ATTACHED" }];
  assert.equal(hasLoyaltyCodeApplied(alreadyLoyaltyOrder), true);
  assert.equal(subscriptionHasLoyaltyCoupon(alreadyLoyaltySub), true);
});

// ── subscriptionLoyaltyCouponCodes — the same-vs-different-code split ─
// Spec: apply-loyalty-coupon-same-code-reapply-is-idempotent-success-not-stacking.
// A same-code re-apply is idempotent success (ticket be3d6ab7: the first
// apply landed LOYALTY-15-8M8HKP; the next three retries hit the coarse
// "already has a loyalty coupon" refusal → false escalation to June). The
// stacking-cap refusal must fire ONLY when a DIFFERENT LOYALTY-* code is
// on the sub (real single-$15 ceiling case the hard-cap spec intended).

test("subscriptionLoyaltyCouponCodes: extracts the LOYALTY-* codes uppercased for same-code comparison", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ title: "LOYALTY-15-ABC123" }]),
    ["LOYALTY-15-ABC123"],
  );
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ code: "loyalty-15-xyz" }]),
    ["LOYALTY-15-XYZ"],
  );
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes(["LOYALTY-10-QQ", "SAVE10"]),
    ["LOYALTY-10-QQ"],
  );
});

test("subscriptionLoyaltyCouponCodes: legacy smile-* included (same tolerant family)", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([{ title: "smile-abc-15" }]),
    ["SMILE-ABC-15"],
  );
});

test("subscriptionLoyaltyCouponCodes: no loyalty codes → [] (a fresh apply is legitimate — guard proceeds)", () => {
  assert.deepEqual(subscriptionLoyaltyCouponCodes([]), []);
  assert.deepEqual(subscriptionLoyaltyCouponCodes(null), []);
  assert.deepEqual(subscriptionLoyaltyCouponCodes([{ title: "SAVE10" }]), []);
});

test("subscriptionLoyaltyCouponCodes: multiple loyalty codes on the sub (pathological — a prior stacking bug leaked one through)", () => {
  assert.deepEqual(
    subscriptionLoyaltyCouponCodes([
      { title: "LOYALTY-15-AAA" },
      { title: "LOYALTY-15-BBB" },
    ]),
    ["LOYALTY-15-AAA", "LOYALTY-15-BBB"],
  );
});

test("apply_loyalty_coupon guard semantics: same code already on the sub → idempotent success (no different-code entry)", () => {
  const applied = [{ title: "LOYALTY-15-8M8HKP" }];
  const incoming = "LOYALTY-15-8M8HKP";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(existing.length, 1, "exactly one loyalty code present");
  assert.equal(different.length, 0, "no DIFFERENT loyalty code → guard returns success (ticket be3d6ab7 no longer re-escalates)");
});

test("apply_loyalty_coupon guard semantics: same-code re-apply is case-insensitive (Shopify may normalize case)", () => {
  const applied = [{ title: "loyalty-15-8m8hkp" }];
  const incoming = "LOYALTY-15-8M8HKP";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 0);
});

test("apply_loyalty_coupon guard semantics: DIFFERENT loyalty code on the sub → refuse (the real single-$15 ceiling stacking case)", () => {
  const applied = [{ title: "LOYALTY-15-EXISTING" }];
  const incoming = "LOYALTY-15-INCOMING";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 1, "a different loyalty code IS present — refuse stacks past the cap");
  assert.equal(different[0], "LOYALTY-15-EXISTING");
});

test("apply_loyalty_coupon guard semantics: same code PLUS a different loyalty code → refuse (the different one still means stacking)", () => {
  const applied = [{ title: "LOYALTY-15-SAME" }, { title: "LOYALTY-15-OTHER" }];
  const incoming = "LOYALTY-15-SAME";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  const different = existing.filter((c) => c !== incoming.toUpperCase());
  assert.equal(different.length, 1, "the OTHER loyalty code makes this a stacking case regardless of the SAME hit");
});

test("apply_loyalty_coupon guard semantics: no loyalty code on the sub → guard proceeds to the mint/apply path (existing = [])", () => {
  const applied = [{ title: "SAVE10" }];
  const incoming = "LOYALTY-15-FRESH";
  const existing = subscriptionLoyaltyCouponCodes(applied);
  assert.equal(existing.length, 0, "no loyalty codes → this is a fresh apply, guard does not fire");
  // guard body only runs when existing.length > 0 — mirror the handler
  assert.ok(!(existing.length > 0));
});

// ── Handler-level ordering: owner-mismatch MUST run BEFORE the same-code
// idempotent-success return (spec: apply-loyalty-coupon-same-code-reapply-
// is-idempotent-success-not-stacking Phase 2 — pre-merge security review).
// A request with a mismatched coupon/contract pair where the sub's
// applied_discounts already carries the incoming code MUST return the
// mismatch refusal, not `{ success: true }`. Without the ordering the
// idempotent-success return would stamp a successful authorization state
// for a coupon this contract owner does not own.

type OrderingRow = Record<string, unknown>;
type OrderingTables = Record<string, OrderingRow[]>;
interface OrderingFilter { col: string; val: unknown; op: "eq" | "in" | "is" }

function orderingMatches(row: OrderingRow, filters: OrderingFilter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.op === "eq") { if (v !== f.val) return false; continue }
    if (f.op === "in") {
      const set = f.val as unknown[];
      if (!Array.isArray(set) || !set.includes(v)) return false;
      continue;
    }
    if (f.op === "is") {
      if (f.val === null && v != null) return false;
      continue;
    }
  }
  return true;
}

function makeOrderingChain(tables: OrderingTables, table: string) {
  const filters: OrderingFilter[] = [];
  const chain: {
    select: (...args: unknown[]) => typeof chain;
    eq: (col: string, val: unknown) => typeof chain;
    in: (col: string, vals: unknown[]) => typeof chain;
    is: (col: string, val: unknown) => typeof chain;
    order: (...args: unknown[]) => typeof chain;
    limit: (...args: unknown[]) => typeof chain;
    maybeSingle: () => Promise<{ data: OrderingRow | null; error: null }>;
    single: () => Promise<{ data: OrderingRow | null; error: null }>;
    then: <T>(onF?: (v: { data: OrderingRow[] | null; error: null }) => T) => Promise<T>;
  } = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val, op: "eq" }); return chain },
    in: (col, vals) => { filters.push({ col, val: vals, op: "in" }); return chain },
    is: (col, val) => { filters.push({ col, val, op: "is" }); return chain },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => orderingMatches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => orderingMatches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    then: (onF) => {
      const rows = (tables[table] ?? []).filter((r) => orderingMatches(r, filters));
      return Promise.resolve({ data: rows, error: null } as { data: OrderingRow[] | null; error: null }).then(onF);
    },
  };
  return chain;
}

function makeOrderingAdmin(tables: OrderingTables) {
  return { from: (t: string) => makeOrderingChain(tables, t) };
}

test("apply_loyalty_coupon: mismatched coupon-owner + same-code-already-on-sub → returns mismatch refusal, NOT idempotent success", async () => {
  // Sandra-Lutz shape: two linked customers (GMAIL + YAHOO). The offered
  // coupon LOYALTY-15-YAHOOX was minted for YAHOO. The subscription is
  // owned by GMAIL. Attacker-shaped state: applied_discounts on the sub
  // already contains the incoming code (e.g. planted by another writer
  // or a stale sync). Without the ordering fix, the same-code guard
  // would return `{ success: true }` before the mismatch check ever ran.
  const tables: OrderingTables = {
    subscriptions: [
      {
        workspace_id: "ws-1",
        shopify_contract_id: "gid://shopify/SubscriptionContract/999",
        customer_id: "uuid-cust-gmail",
        // The vulnerable state: sub already carries the incoming code.
        applied_discounts: [{ title: "LOYALTY-15-YAHOOX" }],
      },
    ],
    customers: [
      { id: "uuid-cust-gmail", workspace_id: "ws-1", shopify_customer_id: "shopify-cust-GMAIL" },
      { id: "uuid-cust-yahoo", workspace_id: "ws-1", shopify_customer_id: "shopify-cust-YAHOO" },
    ],
    customer_links: [
      { workspace_id: "ws-1", customer_id: "uuid-cust-gmail", group_id: "grp-sandra" },
      { workspace_id: "ws-1", customer_id: "uuid-cust-yahoo", group_id: "grp-sandra" },
    ],
    loyalty_members: [
      { id: "mem-gmail", workspace_id: "ws-1", customer_id: "uuid-cust-gmail", shopify_customer_id: "shopify-cust-GMAIL" },
      { id: "mem-yahoo", workspace_id: "ws-1", customer_id: "uuid-cust-yahoo", shopify_customer_id: "shopify-cust-YAHOO" },
    ],
    loyalty_redemptions: [
      {
        workspace_id: "ws-1",
        member_id: "mem-yahoo",
        discount_code: "LOYALTY-15-YAHOOX",
        discount_value: 15,
        status: "active",
        used_at: null,
      },
    ],
  };
  const ctx = {
    admin: makeOrderingAdmin(tables) as unknown as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0]["admin"],
    workspaceId: "ws-1",
    ticketId: "t-1",
  } as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0];
  const out = await directActionHandlers.apply_loyalty_coupon(ctx, {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-YAHOOX",
    contract_id: "gid://shopify/SubscriptionContract/999",
  });
  assert.equal(out.success, false, "mismatch must refuse — an idempotent-success return here would authorize a coupon this contract owner does not own");
  const err = out.error ?? "";
  assert.match(err, /shopify-cust-YAHOO/, "refusal names the code's owning Shopify customer");
  assert.match(err, /shopify-cust-GMAIL/, "refusal names the contract's owning Shopify customer");
  assert.doesNotMatch(err, /idempotent no-op/, "must NOT be the same-code idempotent success message");
});

test("apply_loyalty_coupon: SAME-CODE re-apply on an OWNER-MATCH sub → idempotent success (Fix 1 preserves this behavior)", async () => {
  // Owners match — the same-code idempotent success return SHOULD win,
  // because the mismatch check runs first and returns null on a match.
  const tables: OrderingTables = {
    subscriptions: [
      {
        workspace_id: "ws-1",
        shopify_contract_id: "gid://shopify/SubscriptionContract/888",
        customer_id: "uuid-cust-gmail",
        applied_discounts: [{ title: "LOYALTY-15-8M8HKP" }],
      },
    ],
    customers: [
      { id: "uuid-cust-gmail", workspace_id: "ws-1", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_members: [
      { id: "mem-gmail", workspace_id: "ws-1", customer_id: "uuid-cust-gmail", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_redemptions: [
      {
        workspace_id: "ws-1",
        member_id: "mem-gmail",
        discount_code: "LOYALTY-15-8M8HKP",
        discount_value: 15,
        status: "active",
        used_at: null,
      },
    ],
  };
  const ctx = {
    admin: makeOrderingAdmin(tables) as unknown as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0]["admin"],
    workspaceId: "ws-1",
    ticketId: "t-2",
  } as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0];
  const out = await directActionHandlers.apply_loyalty_coupon(ctx, {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-8M8HKP",
    contract_id: "gid://shopify/SubscriptionContract/888",
  });
  assert.equal(out.success, true, "owners match + same code already on sub → idempotent success (ticket be3d6ab7)");
  assert.match(out.summary ?? "", /already applied/i);
  assert.equal(out.couponCode, "LOYALTY-15-8M8HKP");
});

// ── Regen-ROTATION sibling (spec: apply-loyalty-coupon-self-heal-retry-
// recognizes-regenerated-successor-code, ticket d00064a1). The first run
// couldn't apply the ORIGINAL code, regenerated a successor, flipped the
// original redemption active→expired, minted+applied the successor, and
// succeeded. The self-heal verification re-fires with the ORIGINAL code; the
// sub now carries the SUCCESSOR — a DIFFERENT LOYALTY-* code — so the
// different-code branch would false-fail with a no-stacking error. The guard
// must instead recognize the successor is already on the sub and return
// idempotent success.
test("apply_loyalty_coupon: self-heal retry with the ORIGINAL code after a code-rotating regen → idempotent success (successor already on sub)", async () => {
  const tables: OrderingTables = {
    subscriptions: [
      {
        workspace_id: "ws-1",
        shopify_contract_id: "gid://shopify/SubscriptionContract/777",
        customer_id: "uuid-cust-gmail",
        // The successor minted by the completed regen is already on the sub.
        applied_discounts: [{ title: "LOYALTY-15-SUCC" }],
      },
    ],
    customers: [
      { id: "uuid-cust-gmail", workspace_id: "ws-1", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_members: [
      { id: "mem-gmail", workspace_id: "ws-1", customer_id: "uuid-cust-gmail", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_redemptions: [
      // Original code — the regen already consumed it active→expired.
      {
        workspace_id: "ws-1",
        member_id: "mem-gmail",
        discount_code: "LOYALTY-15-ORIG",
        discount_value: 15,
        status: "expired",
        used_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      // Active successor the regen minted (same member + value).
      {
        workspace_id: "ws-1",
        member_id: "mem-gmail",
        discount_code: "LOYALTY-15-SUCC",
        discount_value: 15,
        status: "active",
        used_at: null,
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
  };
  const ctx = {
    admin: makeOrderingAdmin(tables) as unknown as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0]["admin"],
    workspaceId: "ws-1",
    ticketId: "t-3",
  } as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0];
  const out = await directActionHandlers.apply_loyalty_coupon(ctx, {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-ORIG",
    contract_id: "gid://shopify/SubscriptionContract/777",
  });
  assert.equal(out.success, true, "regen successor already on sub → idempotent success, NOT a false no-stacking failure (ticket d00064a1)");
  assert.match(out.summary ?? "", /self-healed to successor/i);
  assert.equal(out.couponCode, "LOYALTY-15-SUCC");
});

// Guard against over-matching: a DIFFERENT-value loyalty coupon on the sub is
// NOT this code's successor — the different-value apply must still refuse.
test("apply_loyalty_coupon: inactive original but the only other code on the sub is a DIFFERENT value → still refuse (no successor match)", async () => {
  const tables: OrderingTables = {
    subscriptions: [
      {
        workspace_id: "ws-1",
        shopify_contract_id: "gid://shopify/SubscriptionContract/776",
        customer_id: "uuid-cust-gmail",
        applied_discounts: [{ title: "LOYALTY-25-OTHER" }],
      },
    ],
    customers: [
      { id: "uuid-cust-gmail", workspace_id: "ws-1", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_members: [
      { id: "mem-gmail", workspace_id: "ws-1", customer_id: "uuid-cust-gmail", shopify_customer_id: "shopify-cust-GMAIL" },
    ],
    loyalty_redemptions: [
      {
        workspace_id: "ws-1",
        member_id: "mem-gmail",
        discount_code: "LOYALTY-15-ORIG",
        discount_value: 15,
        status: "expired",
        used_at: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      // A $25 reward the member legitimately holds — different value, so it is
      // NOT the $15 original's successor.
      {
        workspace_id: "ws-1",
        member_id: "mem-gmail",
        discount_code: "LOYALTY-25-OTHER",
        discount_value: 25,
        status: "active",
        used_at: null,
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
  };
  const ctx = {
    admin: makeOrderingAdmin(tables) as unknown as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0]["admin"],
    workspaceId: "ws-1",
    ticketId: "t-4",
  } as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0];
  const out = await directActionHandlers.apply_loyalty_coupon(ctx, {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-ORIG",
    contract_id: "gid://shopify/SubscriptionContract/776",
  });
  assert.equal(out.success, false, "different-value coupon is not the successor — the single-$ ceiling stacking refusal must still fire");
  assert.match(out.error ?? "", /no stacking/i);
});
