/**
 * Unit tests for the cold-scaler cohort SDK — Bianca goal M4 Phase 2 verification
 * ([[../../../docs/brain/specs/bianca-cold-scaler-cohort-and-daily-ceiling]]).
 *
 * Pins the precedence resolver:
 *   (a) (account, product)         — most specific wins when present
 *   (b) (account, product=NULL)    — falls through to the account default
 *   (c) (NULL, NULL)               — falls through to the workspace default
 *   (d) no active row              — returns null
 *
 * Plus one enumeration test for listActiveColdScalerCohorts sort order
 * (product_id ASC, nulls last).
 *
 * Fake admin mirrors src/lib/media-buyer/publish-gate.test.ts (per-table
 * in-memory tables + chainable filters).
 *
 * Run:
 *   npm run test:media-buyer-cold-scaler-cohort
 *   (or: npx tsx --test src/lib/media-buyer/cold-scaler-cohort.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  getEffectiveMediaBuyerColdScalerCohort,
  listActiveColdScalerCohorts,
} from "./cold-scaler-cohort";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter { kind: "eq"; col: string; val: unknown }

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    if (f.kind === "eq" && row[f.col] !== f.val) return false;
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  const resolveNow = () => {
    const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
    return { data: rows, error: null as null };
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ kind: "eq", col, val }); return chain; },
    then: (onFulfilled) => Promise.resolve(resolveNow()).then(onFulfilled),
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return {
        select: (...args: unknown[]) => makeChain(tables, table).select(...args),
        eq: (col: string, val: unknown) => makeChain(tables, table).eq(col, val),
      };
    },
  } as unknown as Parameters<typeof getEffectiveMediaBuyerColdScalerCohort>[0];
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WS = "ws-1";
const ACCT = "acct-A";
const PRODUCT_A = "prod-A";
const PRODUCT_B = "prod-B";

function cohortRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `cohort-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: WS,
    meta_ad_account_id: null,
    product_id: null,
    scaler_meta_campaign_id: null,
    daily_scaler_ceiling_cents: 200000,
    is_active: true,
    notes: null,
    updated_by: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

// ── (a) precedence — (account, product) most-specific wins ───────────────────

test("getEffectiveMediaBuyerColdScalerCohort — (account, product) exact row wins", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "ws-default", meta_ad_account_id: null, product_id: null, daily_scaler_ceiling_cents: 100000 }),
      cohortRow({ id: "acct-default", meta_ad_account_id: ACCT, product_id: null, daily_scaler_ceiling_cents: 200000 }),
      cohortRow({ id: "prod-exact", meta_ad_account_id: ACCT, product_id: PRODUCT_A, daily_scaler_ceiling_cents: 300000 }),
    ],
  });
  const r = await getEffectiveMediaBuyerColdScalerCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
  });
  assert.ok(r);
  assert.equal(r!.id, "prod-exact");
  assert.equal(r!.dailyScalerCeilingCents, 300000);
});

// ── (b) precedence — falls through to the account default when no product row ─

test("getEffectiveMediaBuyerColdScalerCohort — falls back to (account, product=NULL) default", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "ws-default", meta_ad_account_id: null, product_id: null, daily_scaler_ceiling_cents: 100000 }),
      cohortRow({ id: "acct-default", meta_ad_account_id: ACCT, product_id: null, daily_scaler_ceiling_cents: 200000 }),
      // No product-specific row for PRODUCT_B.
    ],
  });
  const r = await getEffectiveMediaBuyerColdScalerCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_B,
  });
  assert.ok(r);
  assert.equal(r!.id, "acct-default");
  assert.equal(r!.dailyScalerCeilingCents, 200000);
});

// ── (c) precedence — falls through to the workspace default when no account row ─

test("getEffectiveMediaBuyerColdScalerCohort — falls back to workspace (NULL, NULL) default", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "ws-default", meta_ad_account_id: null, product_id: null, daily_scaler_ceiling_cents: 100000 }),
    ],
  });
  const r = await getEffectiveMediaBuyerColdScalerCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
  });
  assert.ok(r);
  assert.equal(r!.id, "ws-default");
  assert.equal(r!.dailyScalerCeilingCents, 100000);
});

// ── (d) no active row → null ─────────────────────────────────────────────────

test("getEffectiveMediaBuyerColdScalerCohort — returns null when no active row exists", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "dormant", is_active: false, meta_ad_account_id: null, product_id: null }),
    ],
  });
  const r = await getEffectiveMediaBuyerColdScalerCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
  });
  assert.equal(r, null);
});

// ── bigint-as-string normalization (the PostgREST gotcha) ────────────────────

test("getEffectiveMediaBuyerColdScalerCohort — normalizes bigint dailyScalerCeilingCents string → number", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "ws-default", meta_ad_account_id: null, product_id: null, daily_scaler_ceiling_cents: "150000" }),
    ],
  });
  const r = await getEffectiveMediaBuyerColdScalerCohort(admin, WS, {});
  assert.ok(r);
  assert.equal(typeof r!.dailyScalerCeilingCents, "number");
  assert.equal(r!.dailyScalerCeilingCents, 150000);
});

// ── listActiveColdScalerCohorts — enumeration + sort order (nulls last) ──────

test("listActiveColdScalerCohorts — returns active rows for the account, product_id ASC, nulls last", async () => {
  const admin = makeAdmin({
    media_buyer_cold_scaler_cohorts: [
      cohortRow({ id: "ws-default", meta_ad_account_id: null, product_id: null }),
      cohortRow({ id: "acct-default", meta_ad_account_id: ACCT, product_id: null }),
      cohortRow({ id: "prod-B", meta_ad_account_id: ACCT, product_id: PRODUCT_B }),
      cohortRow({ id: "prod-A", meta_ad_account_id: ACCT, product_id: PRODUCT_A }),
      cohortRow({ id: "dormant-A", meta_ad_account_id: ACCT, product_id: PRODUCT_A, is_active: false }),
    ],
  });
  const rows = await listActiveColdScalerCohorts(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
  });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["prod-A", "prod-B", "acct-default"],
  );
});
