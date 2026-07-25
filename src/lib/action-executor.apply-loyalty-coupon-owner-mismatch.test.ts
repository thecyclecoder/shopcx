/**
 * Phase-1 owner-mismatch guard for `apply_loyalty_coupon` (spec:
 * loyalty-coupon-apply-resolves-contract-owning-member-no-doomed-regen).
 *
 * Precedent: ticket 2b7ea029 (Sandra Lutz) — two Shopify profiles were
 * linked, the higher-points profile was picked as the loyalty identity
 * and a code was minted for it, then the code was offered against a
 * subscription owned by the OTHER profile. The apply path first strips
 * the contract's existing automatic discounts (via the Appstle apply
 * flow), then fails because the code's customerSelection doesn't include
 * the contract's owner — a doomed apply that also destroys the sub's
 * standing discount stack.
 *
 * Behavior locked in here: when the contract's owning Shopify customer
 * and the code's owning Shopify customer are BOTH resolvable AND they
 * differ, the guard returns a refusal ActionResult naming both — the
 * handler returns it without calling Appstle and without entering regen.
 * When either side can't be resolved, the guard returns null so the
 * ordinary apply path runs (a resolvable ambiguity must not become a
 * refusal).
 *
 * Pure — no live DB, no live Shopify. Uses an in-memory admin fake shaped
 * like supabase-js — mirrors action-executor.atomic-redeem-apply.test.ts.
 *
 * Run:
 *   npx tsx --test src/lib/action-executor.apply-loyalty-coupon-owner-mismatch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { refuseLoyaltyCouponIfCustomerMismatch } from "./action-executor";

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

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  in: (col: string, vals: unknown[]) => FakeChain;
  is: (col: string, val: unknown) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: <T>(onF?: (v: { data: Row[] | null; error: null }) => T) => Promise<T>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ col, val, op: "eq" }); return chain },
    in: (col, vals) => { filters.push({ col, val: vals, op: "in" }); return chain },
    is: (col, val) => { filters.push({ col, val, op: "is" }); return chain },
    maybeSingle: async () => {
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
  return { from: (t: string) => makeChain(tables, t) } as unknown as Parameters<typeof refuseLoyaltyCouponIfCustomerMismatch>[0];
}

// ─── The Sandra Lutz seed: two linked customers, one code, one sub ────

function seedSandra(overrides?: {
  suppressWorkingSibling?: boolean;
  giveThemTheSameShopifyId?: boolean;
}): Tables {
  const yahoo = overrides?.giveThemTheSameShopifyId ? "shopify-cust-GMAIL" : "shopify-cust-YAHOO";
  return {
    subscriptions: [
      {
        workspace_id: "ws-superfoods",
        shopify_contract_id: "gid://shopify/SubscriptionContract/999",
        customer_id: "uuid-cust-gmail",
      },
    ],
    customers: [
      { id: "uuid-cust-gmail", workspace_id: "ws-superfoods", shopify_customer_id: "shopify-cust-GMAIL" },
      { id: "uuid-cust-yahoo", workspace_id: "ws-superfoods", shopify_customer_id: yahoo },
    ],
    customer_links: [
      { workspace_id: "ws-superfoods", customer_id: "uuid-cust-gmail", group_id: "grp-sandra" },
      { workspace_id: "ws-superfoods", customer_id: "uuid-cust-yahoo", group_id: "grp-sandra" },
    ],
    loyalty_members: [
      { id: "mem-gmail", workspace_id: "ws-superfoods", customer_id: "uuid-cust-gmail", shopify_customer_id: "shopify-cust-GMAIL" },
      { id: "mem-yahoo", workspace_id: "ws-superfoods", customer_id: "uuid-cust-yahoo", shopify_customer_id: yahoo },
    ],
    loyalty_redemptions: [
      // The offered code — minted for the YAHOO profile.
      {
        workspace_id: "ws-superfoods",
        member_id: "mem-yahoo",
        discount_code: "LOYALTY-15-YAHOOX",
        discount_value: 15,
        status: "active",
        used_at: null,
      },
      // A same-value sibling reward already sitting on the GMAIL profile —
      // the "reward that WOULD work" the guard should surface. Toggle-off
      // for the negative case.
      ...(overrides?.suppressWorkingSibling ? [] : [
        {
          workspace_id: "ws-superfoods",
          member_id: "mem-gmail",
          discount_code: "LOYALTY-15-GMAILA",
          discount_value: 15,
          status: "active",
          used_at: null,
        },
      ]),
    ],
  };
}

// ─── FAIL-STATE test: mismatch must refuse WITHOUT calling Appstle ────

test("refuses when contract owner and code owner are different Shopify customers (Sandra Lutz fingerprint)", async () => {
  const tables = seedSandra();
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-YAHOOX",
  );
  assert.ok(out, "mismatch must produce a refusal ActionResult, not null");
  assert.equal(out!.success, false, "refusal is success=false so the handler never enters regen or Appstle");
  const err = out!.error ?? "";
  assert.match(err, /shopify-cust-YAHOO/, "error must name the code's owning Shopify customer");
  assert.match(err, /shopify-cust-GMAIL/, "error must name the contract's owning Shopify customer");
  assert.match(err, /LOYALTY-15-GMAILA/, "error must point at the sibling reward that would work");
});

test("mismatch with NO working sibling reward → refusal still names both customers", async () => {
  const tables = seedSandra({ suppressWorkingSibling: true });
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-YAHOOX",
  );
  assert.ok(out);
  assert.match(out!.error ?? "", /shopify-cust-YAHOO/);
  assert.match(out!.error ?? "", /shopify-cust-GMAIL/);
  assert.doesNotMatch(out!.error ?? "", /apply .+ instead/, "no working-code suggestion when the link group carries none");
});

// ─── PASS-STATE tests: owners match → guard returns null → apply proceeds

test("owners match → returns null (guard does not turn a legitimate apply into a refusal)", async () => {
  const tables = seedSandra({ giveThemTheSameShopifyId: true });
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-YAHOOX",
  );
  assert.equal(out, null, "same shopify_customer_id on both sides → no refusal");
});

test("code has no redemption row → returns null (unknown provenance cannot become a refusal)", async () => {
  const tables = seedSandra();
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-UNKNOWN",
  );
  assert.equal(out, null);
});

test("contract has no sub row → returns null (unknown contract provenance)", async () => {
  const tables = seedSandra();
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/DOES-NOT-EXIST", "LOYALTY-15-YAHOOX",
  );
  assert.equal(out, null);
});

test("cross-workspace: the guard's workspace filter blocks a sub row from another tenant", async () => {
  const tables = seedSandra();
  // Move the sub row to another workspace and re-attempt — the guard's
  // workspace_id filter on subscriptions should make the lookup miss.
  (tables.subscriptions![0] as { workspace_id: string }).workspace_id = "ws-OTHER";
  const admin = makeAdmin(tables);
  const out = await refuseLoyaltyCouponIfCustomerMismatch(
    admin, "ws-superfoods", "gid://shopify/SubscriptionContract/999", "LOYALTY-15-YAHOOX",
  );
  assert.equal(out, null, "the sub is in another workspace — nothing to compare, so no refusal fires");
});
