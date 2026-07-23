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
  provisionColdScalerCohort,
  setColdScalerCampaignId,
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

// ── setColdScalerCampaignId — compare-and-set on currently-null column ───────

function makeSetterAdmin(row: Row) {
  return {
    from(_table: string) {
      const filters: Filter[] = [];
      let isNullCol: string | null = null;
      let patch: Row | null = null;
      const chain = {
        update: (values: Row) => { patch = values; return chain; },
        eq: (col: string, val: unknown) => { filters.push({ kind: "eq", col, val }); return chain; },
        is: (col: string, val: unknown) => {
          if (val !== null) throw new Error("only .is(col, null) is stubbed");
          isNullCol = col;
          return chain;
        },
        select: async (_: string) => {
          const matched = matches(row, filters) && (isNullCol == null || row[isNullCol] === null);
          if (matched && patch) {
            for (const k of Object.keys(patch)) row[k] = patch[k];
            return { data: [{ id: row.id }], error: null };
          }
          return { data: [], error: null };
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof setColdScalerCampaignId>[0];
}

test("setColdScalerCampaignId — stamps when column is null, no-ops when someone else stamped first", async () => {
  const row = cohortRow({ id: "cohort-x", meta_ad_account_id: ACCT, product_id: null });
  const admin = makeSetterAdmin(row);
  const first = await setColdScalerCampaignId(admin, {
    cohortId: "cohort-x",
    scalerMetaCampaignId: "meta-camp-1",
  });
  assert.equal(first.stamped, 1);
  assert.equal(row.scaler_meta_campaign_id, "meta-camp-1");
  const second = await setColdScalerCampaignId(admin, {
    cohortId: "cohort-x",
    scalerMetaCampaignId: "meta-camp-2",
  });
  assert.equal(second.stamped, 0, "second call must no-op because column is no longer null");
  assert.equal(row.scaler_meta_campaign_id, "meta-camp-1", "must not overwrite the first stamp");
});

// ── provisionColdScalerCohort — sanctioned retire+insert writer ──────────────

type ProvisionerState = {
  mode: "update" | "insert" | null;
  filters: Record<string, unknown>;
  isNulls: string[];
  patch: Row | null;
  insertRow: Row | null;
};

interface ProvisionerCapture {
  retires: Array<{ filters: Record<string, unknown>; isNulls: string[]; patch: Row }>;
  inserts: Row[];
}

function makeProvisionerAdmin(): {
  admin: Parameters<typeof provisionColdScalerCohort>[0];
  capture: ProvisionerCapture;
} {
  const capture: ProvisionerCapture = { retires: [], inserts: [] };
  let idCounter = 0;
  const admin = {
    from(_t: string) {
      const state: ProvisionerState = { mode: null, filters: {}, isNulls: [], patch: null, insertRow: null };
      const chain = {
        update(v: Row) { state.mode = "update"; state.patch = v; return chain; },
        insert(r: Row) { state.mode = "insert"; state.insertRow = r; return chain; },
        eq(k: string, v: unknown) { state.filters[k] = v; return chain; },
        is(k: string, _v: null) { state.isNulls.push(k); return chain; },
        select(_cols?: string) {
          if (state.mode === "insert" && state.insertRow) {
            idCounter += 1;
            const row: Row = { id: `mock-${idCounter}`, ...state.insertRow };
            capture.inserts.push(row);
            return {
              single: async () => ({ data: { id: row.id }, error: null as null }),
            };
          }
          return { single: async () => ({ data: null, error: null as null }) };
        },
        then(onFulfilled: (v: { data: null; error: null }) => unknown) {
          if (state.mode === "update" && state.patch) {
            capture.retires.push({
              filters: { ...state.filters },
              isNulls: [...state.isNulls],
              patch: { ...state.patch },
            });
          }
          return Promise.resolve({ data: null, error: null as null }).then(onFulfilled);
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof provisionColdScalerCohort>[0];
  return { admin, capture };
}

test("provisionColdScalerCohort — inserts an active row with the ceiling and returns cohortId", async () => {
  const { admin, capture } = makeProvisionerAdmin();
  const result = await provisionColdScalerCohort(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
    dailyScalerCeilingCents: 250000,
    notes: "seed",
  });
  assert.equal(result.cohortId, "mock-1");
  assert.equal(result.dailyScalerCeilingCents, 250000);
  assert.equal(result.metaAdAccountId, ACCT);
  assert.equal(result.productId, PRODUCT_A);
  assert.equal(capture.inserts.length, 1);
  const row = capture.inserts[0];
  assert.equal(row.workspace_id, WS);
  assert.equal(row.meta_ad_account_id, ACCT);
  assert.equal(row.product_id, PRODUCT_A);
  assert.equal(row.daily_scaler_ceiling_cents, 250000);
  assert.equal(row.is_active, true);
  assert.equal(row.notes, "seed");
});

test("provisionColdScalerCohort — retires ANY prior active row for the same scope (partial-unique-index guard)", async () => {
  const { admin, capture } = makeProvisionerAdmin();
  await provisionColdScalerCohort(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
    dailyScalerCeilingCents: 300000,
  });
  assert.equal(capture.retires.length, 1);
  const retire = capture.retires[0];
  assert.equal(retire.filters.workspace_id, WS);
  assert.equal(retire.filters.meta_ad_account_id, ACCT);
  assert.equal(retire.filters.product_id, PRODUCT_A);
  assert.equal(retire.filters.is_active, true);
  assert.equal(retire.patch.is_active, false);
});

test("provisionColdScalerCohort — workspace-wide (null scope) uses .is() so the unique index compares as-null", async () => {
  const { admin, capture } = makeProvisionerAdmin();
  const r = await provisionColdScalerCohort(admin, {
    workspaceId: WS,
    dailyScalerCeilingCents: 100000,
  });
  assert.equal(r.metaAdAccountId, null);
  assert.equal(r.productId, null);
  assert.equal(capture.inserts[0].meta_ad_account_id, null);
  assert.equal(capture.inserts[0].product_id, null);
  assert.ok(capture.retires[0].isNulls.includes("meta_ad_account_id"));
  assert.ok(capture.retires[0].isNulls.includes("product_id"));
});

test("provisionColdScalerCohort — throws when daily_scaler_ceiling_cents ≤ 0 (never seed an unbounded ceiling)", async () => {
  const { admin } = makeProvisionerAdmin();
  await assert.rejects(
    provisionColdScalerCohort(admin, {
      workspaceId: WS,
      dailyScalerCeilingCents: 0,
    }),
    /daily_scaler_ceiling_cents_must_be_positive/,
  );
  await assert.rejects(
    provisionColdScalerCohort(admin, {
      workspaceId: WS,
      dailyScalerCeilingCents: -1,
    }),
    /daily_scaler_ceiling_cents_must_be_positive/,
  );
});

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
