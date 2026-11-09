/**
 * Already-spent guard for `apply_loyalty_coupon`
 * (spec: internal-renewal-consumes-loyalty-redemption Phase 1).
 *
 * Ground truth: Mary Tanner's internal order SHOPCX695 (2026-11-06) took her
 * $15 LOYALTY-15-C5YE9N off the Braintree charge, but because internal orders
 * never pass through the Shopify order webhook (the only caller of
 * consumeRedemption at the time), the redemption stayed status=active /
 * used_at=null. Sol saw an "unused" reward and applied it AGAIN to her Jan 1
 * renewal — $15 honored twice.
 *
 * Fix: internal renewals now call consumeRedemption('subscription_renewal')
 * for each LOYALTY-* code that reduced the charge, stamping used_at. And
 * apply_loyalty_coupon now refuses a code whose redemption already has used_at
 * set — a spent reward can't be re-applied. This test locks in that refusal,
 * and the consume-decision helper that selects which codes get consumed.
 *
 * Pure — no live DB, no live Shopify. In-memory admin fake shaped like
 * supabase-js — mirrors action-executor.loyalty-order-stacking-guards.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.loyalty-redemption-used-refusal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { directActionHandlers } from "./action-executor";
import { loyaltyCodesToConsume } from "./inngest/internal-subscription-renewals";

// ── In-memory admin fake (same shape as the stacking-guards test) ──────
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
interface Filter { col: string; val: unknown; op: "eq" | "in" | "is" }

function matches(row: Row, filters: Filter[]): boolean {
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

function makeChain(tables: Tables, table: string) {
  const filters: Filter[] = [];
  const chain: {
    select: (...args: unknown[]) => typeof chain;
    eq: (col: string, val: unknown) => typeof chain;
    in: (col: string, vals: unknown[]) => typeof chain;
    is: (col: string, val: unknown) => typeof chain;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
    single: () => Promise<{ data: Row | null; error: null }>;
    then: <T>(onF?: (v: { data: Row[] | null; error: null }) => T) => Promise<T>;
  } = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val, op: "eq" }); return chain },
    in: (col, vals) => { filters.push({ col, val: vals, op: "in" }); return chain },
    is: (col, val) => { filters.push({ col, val, op: "is" }); return chain },
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    then: (onF) => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return Promise.resolve({ data: rows, error: null } as { data: Row[] | null; error: null }).then(onF);
    },
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return { from: (t: string) => makeChain(tables, t) };
}

// Mary's shape: the sub is owned by one customer, the redemption is for the
// same customer (no owner mismatch), the same code already sits on the sub.
function seedMary(opts: { used: boolean }): Tables {
  return {
    subscriptions: [
      {
        workspace_id: "ws-1",
        shopify_contract_id: "internal-mary-0001",
        customer_id: "uuid-mary",
        applied_discounts: [{ code: "LOYALTY-15-C5YE9N" }],
      },
    ],
    customers: [
      { id: "uuid-mary", workspace_id: "ws-1", shopify_customer_id: "shopify-mary" },
    ],
    loyalty_members: [
      { id: "mem-mary", workspace_id: "ws-1", customer_id: "uuid-mary", shopify_customer_id: "shopify-mary" },
    ],
    loyalty_redemptions: [
      {
        workspace_id: "ws-1",
        member_id: "mem-mary",
        discount_code: "LOYALTY-15-C5YE9N",
        discount_value: 15,
        status: opts.used ? "used" : "active",
        used_at: opts.used ? "2026-11-06T12:00:00.000Z" : null,
      },
    ],
  };
}

function maryCtx(tables: Tables) {
  return {
    admin: makeAdmin(tables) as unknown as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0]["admin"],
    workspaceId: "ws-1",
    ticketId: "t-mary",
  } as Parameters<typeof directActionHandlers.apply_loyalty_coupon>[0];
}

// ── FAIL-STATE → correct-state: a spent reward can't be re-applied ─────

test("apply_loyalty_coupon: redemption already used (used_at set) → refuses, never re-applies (Mary Tanner $15-twice fingerprint)", async () => {
  const out = await directActionHandlers.apply_loyalty_coupon(maryCtx(seedMary({ used: true })), {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-C5YE9N",
    contract_id: "internal-mary-0001",
  });
  assert.equal(out.success, false, "a consumed reward must refuse — re-applying would honor $15 twice");
  const err = out.error ?? "";
  assert.match(err, /already redeemed/i, "error must state the reward was already redeemed");
  assert.match(err, /LOYALTY-15-C5YE9N/, "error names the spent code");
  assert.doesNotMatch(err, /idempotent no-op/i, "must be the used-refusal, not the same-code idempotent success");
});

test("apply_loyalty_coupon: same redemption still unused (used_at null) → used-guard does NOT fire (reaches idempotent success)", async () => {
  // Identical setup but the redemption is unused — the used-guard must let it
  // through so the normal same-code idempotent-success path still applies.
  const out = await directActionHandlers.apply_loyalty_coupon(maryCtx(seedMary({ used: false })), {
    type: "apply_loyalty_coupon",
    code: "LOYALTY-15-C5YE9N",
    contract_id: "internal-mary-0001",
  });
  assert.equal(out.success, true, "an unused redemption is not blocked by the used-guard");
  assert.doesNotMatch(out.error ?? "", /already redeemed/i, "used-guard must not fire on an unused redemption");
});

// ── The consume-decision helper (which codes an internal renewal consumes) ──

test("loyaltyCodesToConsume: picks only LOYALTY-* codes that reduced the charge", () => {
  assert.deepEqual(
    loyaltyCodesToConsume(["LOYALTY-15-C5YE9N", "WELCOME10", "SAVE5"]),
    ["LOYALTY-15-C5YE9N"],
  );
});

test("loyaltyCodesToConsume: case-insensitive on the prefix, dedups repeats", () => {
  assert.deepEqual(
    loyaltyCodesToConsume(["loyalty-10-aaa", "LOYALTY-10-AAA", "LOYALTY-15-BBB"]),
    ["loyalty-10-aaa", "LOYALTY-15-BBB"],
  );
});

test("loyaltyCodesToConsume: no loyalty codes → [] (nothing to consume)", () => {
  assert.deepEqual(loyaltyCodesToConsume([]), []);
  assert.deepEqual(loyaltyCodesToConsume(["WELCOME10", "SUMMER"]), []);
});

test("loyaltyCodesToConsume: tolerates blanks / non-strings without crashing", () => {
  assert.deepEqual(
    loyaltyCodesToConsume(["", "  ", "LOYALTY-15-OK", null as unknown as string]),
    ["LOYALTY-15-OK"],
  );
});
