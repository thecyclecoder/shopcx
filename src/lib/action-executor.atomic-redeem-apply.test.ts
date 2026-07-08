/**
 * Unit tests for the atomic redeem→apply guardrail — the fix for
 * ticket 0a9e4d7f (Judy: 1,500 pts spent, apply_loyalty_coupon bailed
 * with "Missing coupon code", NO coupon landed).
 *
 * Two behaviors are locked in here:
 *
 * 1. `substituteActionParams` threads the code from a prior successful
 *    redeem_points into a paired apply_(loyalty_)coupon even when
 *    Sonnet emits the apply action WITHOUT the `{{coupon_code}}`
 *    template. Judy's failure was exactly this: no template → no
 *    substitution → handler bailed on missing code.
 *
 * 2. `rollbackLoyaltyRedemptionOnApplyFailure` re-credits the spent
 *    points and flips the loyalty_redemptions row to `rolled_back`
 *    when the paired apply didn't land — either initial handler
 *    failure or verify+retry failure. Idempotent + only touches an
 *    `active` row (the apply_loyalty_coupon regen path uses
 *    `expired`, so leaving non-active rows alone avoids
 *    double-refunding a regen sequence).
 *
 * Pure — no live DB. Uses an in-memory fake admin. Run:
 *   npx tsx --test src/lib/action-executor.atomic-redeem-apply.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  rollbackLoyaltyRedemptionOnApplyFailure,
  substituteActionParams,
  type ActionParams,
  type ActionResult,
} from "./action-executor";

// ── In-memory fake admin (minimal chain surface) ─────────────────────

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
  update: (patch: Row) => FakeChain;
  insert: (row: Row) => Promise<{ data: null; error: null }>;
  single: () => Promise<{ data: Row | null; error: null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: <TResult>(
    onFulfilled?: (v: { data: null; error: null }) => TResult | PromiseLike<TResult>,
  ) => Promise<TResult>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  let pendingUpdate: Row | null = null;
  const applyPendingUpdate = () => {
    if (!pendingUpdate) return;
    const all = tables[table] ?? [];
    for (const row of all) {
      if (matches(row, filters)) Object.assign(row, pendingUpdate);
    }
    pendingUpdate = null;
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val }); return chain },
    update: (patch) => { pendingUpdate = { ...patch }; return chain },
    insert: async (row) => {
      (tables[table] ??= []).push({ ...row });
      return { data: null, error: null };
    },
    single: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      return { data: rows[0] ?? null, error: null };
    },
    then: (onFulfilled) => {
      // Thenable — resolves the pending .update() at await-time so
      // `.update({...}).eq('id', x)` mirrors supabase-js's PostgrestBuilder.
      applyPendingUpdate();
      return Promise.resolve({ data: null, error: null }).then(onFulfilled);
    },
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from: (table: string) => makeChain(tables, table),
  } as unknown as Parameters<typeof rollbackLoyaltyRedemptionOnApplyFailure>[0]["admin"];
}

function makeCtx(tables: Tables) {
  return {
    admin: makeAdmin(tables),
    workspaceId: "ws-1",
    ticketId: "ticket-1",
  };
}

function successResult(couponCode?: string): ActionResult {
  return { success: true, couponCode };
}

function failResult(error: string): ActionResult {
  return { success: false, error };
}

// ── substituteActionParams — the code-threading fallback ─────────────

test("substituteActionParams: threads code from prior redeem_points into apply_loyalty_coupon (no template)", () => {
  // Judy's exact case — Sonnet emits apply_loyalty_coupon with NO
  // {{coupon_code}} template. The map has nothing to substitute into,
  // but the fallback threads the code directly by action-type match.
  const redeem: ActionParams = { type: "redeem_points", tier_index: 2 };
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "gid://shopify/SubscriptionContract/1" };

  const out = substituteActionParams(apply, [
    { action: redeem, result: successResult("LOYALTY-15-HC6UFJ") },
  ]);

  assert.equal(out.code, "LOYALTY-15-HC6UFJ", "code must be threaded from prior redeem_points result");
});

test("substituteActionParams: substitutes {{coupon_code}} placeholder as before", () => {
  const redeem: ActionParams = { type: "redeem_points" };
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "c1", code: "{{coupon_code}}" };
  const out = substituteActionParams(apply, [
    { action: redeem, result: successResult("LOYALTY-15-ABC123") },
  ]);
  assert.equal(out.code, "LOYALTY-15-ABC123");
});

test("substituteActionParams: threads over unsubstituted [COUPON_CODE] token if map was empty", () => {
  // Defensive: even if the token remains after substitution
  // (nothing in map), the fallback overrides it with the last coupon.
  const redeem: ActionParams = { type: "redeem_points" };
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "c1", code: "[COUPON_CODE]" };
  const out = substituteActionParams(apply, [
    { action: redeem, result: successResult("LOYALTY-10-QQQ") },
  ]);
  assert.equal(out.code, "LOYALTY-10-QQQ");
});

test("substituteActionParams: does NOT override an explicit real code Sonnet passed", () => {
  const redeem: ActionParams = { type: "redeem_points" };
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "c1", code: "PROMO-SUMMER" };
  const out = substituteActionParams(apply, [
    { action: redeem, result: successResult("LOYALTY-15-ABC") },
  ]);
  assert.equal(out.code, "PROMO-SUMMER", "an explicit code from Sonnet must win over the fallback");
});

test("substituteActionParams: no redeem_points → no fallback code injected", () => {
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "c1" };
  const out = substituteActionParams(apply, []);
  assert.equal(out.code, undefined);
});

test("substituteActionParams: fallback does not fire when a prior redeem_points FAILED", () => {
  const redeem: ActionParams = { type: "redeem_points" };
  const apply: ActionParams = { type: "apply_loyalty_coupon", contract_id: "c1" };
  const out = substituteActionParams(apply, [
    { action: redeem, result: failResult("Invalid tier") },
  ]);
  assert.equal(out.code, undefined);
});

// ── rollbackLoyaltyRedemptionOnApplyFailure — the atomic contract ────

test("rollback: apply_loyalty_coupon FAILED after redeem_points success → points re-credited + redemption rolled_back (Judy's exact case)", async () => {
  const tables: Tables = {
    loyalty_members: [
      {
        id: "mem-1",
        workspace_id: "ws-1",
        customer_id: "cust-1",
        shopify_customer_id: "sc-1",
        points_balance: 500, // remaining after 1,500 pt spend from 2,000
        points_spent: 1500,
        points_earned: 2000,
      },
    ],
    loyalty_redemptions: [
      {
        id: "red-1",
        workspace_id: "ws-1",
        member_id: "mem-1",
        discount_code: "LOYALTY-15-HC6UFJ",
        points_spent: 1500,
        status: "active",
      },
    ],
    loyalty_transactions: [],
  };
  const ctx = makeCtx(tables);
  const sysNotes: string[] = [];
  const sysNote = async (m: string) => { sysNotes.push(m) };

  await rollbackLoyaltyRedemptionOnApplyFailure(
    ctx,
    [
      { action: { type: "redeem_points" }, result: successResult("LOYALTY-15-HC6UFJ") },
      {
        action: { type: "apply_loyalty_coupon", contract_id: "c1" },
        result: failResult("Missing coupon code (pass via 'code')"),
      },
    ],
    [],
    sysNote,
  );

  const member = tables.loyalty_members[0]!;
  assert.equal(member.points_balance, 2000, "points_balance restored to pre-spend value");

  const red = tables.loyalty_redemptions[0]!;
  assert.equal(red.status, "rolled_back", "redemption row flipped from active to rolled_back");

  const tx = tables.loyalty_transactions[0]!;
  assert.equal(tx?.points_change, 1500, "an adjustment transaction is written for the re-credit");
  assert.equal(tx?.type, "adjustment");

  assert.ok(
    sysNotes.some((n) => n.includes("[Rollback]")),
    "a [Rollback] system note is emitted for the audit trail",
  );
});

test("rollback: apply_loyalty_coupon SUCCEEDED-but-verify-failed after redeem → still rolls back", async () => {
  const tables: Tables = {
    loyalty_members: [{
      id: "mem-2", workspace_id: "ws-1", customer_id: "cust-2", shopify_customer_id: "sc-2",
      points_balance: 0, points_spent: 500, points_earned: 500,
    }],
    loyalty_redemptions: [{
      id: "red-2", workspace_id: "ws-1", member_id: "mem-2",
      discount_code: "LOYALTY-5-XYZ", points_spent: 500, status: "active",
    }],
    loyalty_transactions: [],
  };
  const ctx = makeCtx(tables);
  const sysNote = async () => {};

  await rollbackLoyaltyRedemptionOnApplyFailure(
    ctx,
    [
      { action: { type: "redeem_points" }, result: successResult("LOYALTY-5-XYZ") },
      { action: { type: "apply_loyalty_coupon", contract_id: "c2", code: "LOYALTY-5-XYZ" }, result: successResult() },
    ],
    ["apply_loyalty_coupon: retry failed — Appstle 400"],
    sysNote,
  );

  assert.equal(tables.loyalty_members[0]!.points_balance, 500);
  assert.equal(tables.loyalty_redemptions[0]!.status, "rolled_back");
});

test("rollback: no-op when apply succeeded AND verify passed", async () => {
  const tables: Tables = {
    loyalty_members: [{
      id: "mem-3", workspace_id: "ws-1", customer_id: "c3", shopify_customer_id: "s3",
      points_balance: 0, points_spent: 500, points_earned: 500,
    }],
    loyalty_redemptions: [{
      id: "red-3", workspace_id: "ws-1", member_id: "mem-3",
      discount_code: "LOYALTY-5-OK", points_spent: 500, status: "active",
    }],
    loyalty_transactions: [],
  };
  const ctx = makeCtx(tables);
  const sysNote = async () => {};

  await rollbackLoyaltyRedemptionOnApplyFailure(
    ctx,
    [
      { action: { type: "redeem_points" }, result: successResult("LOYALTY-5-OK") },
      { action: { type: "apply_loyalty_coupon", contract_id: "c3", code: "LOYALTY-5-OK" }, result: successResult() },
    ],
    [],
    sysNote,
  );

  assert.equal(tables.loyalty_members[0]!.points_balance, 0, "no re-credit on a legitimate spend");
  assert.equal(tables.loyalty_redemptions[0]!.status, "active", "redemption stays active");
  assert.equal(tables.loyalty_transactions.length, 0, "no adjustment transaction on the happy path");
});

test("rollback: skips a redemption whose status is already non-active (regen path safety)", async () => {
  // The apply_loyalty_coupon handler's internal regen mutates the
  // original row to `expired` when re-minting. Leaving non-active
  // rows alone avoids double-refunding a regen sequence. Phase 2
  // will fold the regen-then-fail edge case in.
  const tables: Tables = {
    loyalty_members: [{
      id: "mem-4", workspace_id: "ws-1", customer_id: "c4", shopify_customer_id: "s4",
      points_balance: 0, points_spent: 500, points_earned: 500,
    }],
    loyalty_redemptions: [{
      id: "red-4a", workspace_id: "ws-1", member_id: "mem-4",
      discount_code: "LOYALTY-5-OLD", points_spent: 500, status: "expired",
    }],
    loyalty_transactions: [],
  };
  const ctx = makeCtx(tables);
  const sysNote = async () => {};

  await rollbackLoyaltyRedemptionOnApplyFailure(
    ctx,
    [
      { action: { type: "redeem_points" }, result: successResult("LOYALTY-5-OLD") },
      { action: { type: "apply_loyalty_coupon", contract_id: "c4" }, result: failResult("nope") },
    ],
    [],
    sysNote,
  );

  assert.equal(tables.loyalty_members[0]!.points_balance, 0, "no re-credit on a non-active row");
  assert.equal(tables.loyalty_redemptions[0]!.status, "expired");
  assert.equal(tables.loyalty_transactions.length, 0);
});

test("rollback: no prior redeem_points success → no-op even on apply failure", async () => {
  const tables: Tables = {
    loyalty_members: [],
    loyalty_redemptions: [],
    loyalty_transactions: [],
  };
  const ctx = makeCtx(tables);
  const sysNote = async () => {};

  await rollbackLoyaltyRedemptionOnApplyFailure(
    ctx,
    [
      { action: { type: "apply_loyalty_coupon", contract_id: "c5", code: "LOYALTY-15-ABC" }, result: failResult("bad") },
    ],
    [],
    sysNote,
  );

  assert.equal(tables.loyalty_transactions.length, 0);
});
