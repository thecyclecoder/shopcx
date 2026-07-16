/**
 * Unit tests for the media-buyer publish gate — Phase 1 verification
 * (media-buyer-test-winner-loop). Covers all 3 branches called out in the spec:
 *
 *   1. Configured test ad set + under-ceiling projected daily → gate ALLOWS
 *      (publish_active=true is retained; the caller flips the ad to ACTIVE).
 *   2. A DIFFERENT ad set → gate REFUSES with reason='wrong_adset'; the caller
 *      publishes PAUSED + records an escalation.
 *   3. The configured test ad set BUT projected daily over the ceiling → gate
 *      REFUSES with reason='over_ceiling'; PAUSED + escalation.
 *
 * Plus the fourth branch the spec's verification does NOT name but the gate must
 * still cover: NO active cohort row → gate REFUSES with reason='no_active_cohort'.
 *
 * The fake admin mirrors src/lib/ad-spend-governor.test.ts (per-table in-memory
 * table, chainable filters, insert appends). Enough surface for the gate + the
 * escalation helper (which reads/inserts dashboard_notifications + director_activity
 * through escalateDiagnosisToCeo and recordDirectorActivity).
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/publish-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMediaBuyerTestPublish,
  escalateMediaBuyerTestPublishRefusal,
  getEffectiveMediaBuyerTestCohort,
  MEDIA_BUYER_TEST_ORIGIN,
} from "./publish-gate";

// ── Fake admin client (matches ad-spend-governor.test.ts shape) ──────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

interface Filter {
  kind: "eq" | "gte" | "lte" | "is" | "not_is_null" | "in";
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.kind === "eq" && v !== f.val) return false;
    if (f.kind === "gte" && !(typeof v === "string" && typeof f.val === "string" && v >= f.val)) return false;
    if (f.kind === "lte" && !(typeof v === "string" && typeof f.val === "string" && v <= f.val)) return false;
    if (f.kind === "is" && f.val === null && v !== null && v !== undefined) return false;
    if (f.kind === "not_is_null" && (v === null || v === undefined)) return false;
    if (f.kind === "in" && !(Array.isArray(f.val) && (f.val as unknown[]).includes(v))) return false;
  }
  return true;
}

interface FakeChain {
  select: (...args: unknown[]) => FakeChain;
  eq: (col: string, val: unknown) => FakeChain;
  gte: (col: string, val: unknown) => FakeChain;
  lte: (col: string, val: unknown) => FakeChain;
  is: (col: string, val: unknown) => FakeChain;
  not: (col: string, op: string, val: unknown) => FakeChain;
  in: (col: string, val: unknown[]) => FakeChain;
  order: (...args: unknown[]) => FakeChain;
  limit: (n: number) => FakeChain;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: (onFulfilled: (v: { data: Row[]; error: null }) => unknown) => Promise<unknown>;
}

function makeChain(tables: Tables, table: string): FakeChain {
  const filters: Filter[] = [];
  let limitN: number | null = null;
  const resolve = () => {
    const all = tables[table] ?? [];
    let rows = all.filter((r) => matches(r, filters));
    if (limitN != null) rows = rows.slice(0, limitN);
    return { data: rows, error: null as null };
  };
  const chain: FakeChain = {
    select: () => chain,
    eq: (col, val) => { filters.push({ kind: "eq", col, val }); return chain; },
    gte: (col, val) => { filters.push({ kind: "gte", col, val }); return chain; },
    lte: (col, val) => { filters.push({ kind: "lte", col, val }); return chain; },
    is: (col, val) => { filters.push({ kind: "is", col, val }); return chain; },
    not: (col, op, val) => { if (op === "is" && val === null) filters.push({ kind: "not_is_null", col, val: null }); return chain; },
    in: (col, val) => { filters.push({ kind: "in", col, val }); return chain; },
    order: () => chain,
    limit: (n) => { limitN = n; return chain; },
    maybeSingle: async () => {
      const r = resolve();
      return { data: r.data[0] ?? null, error: null };
    },
    then: (onFulfilled) => Promise.resolve(resolve()).then(onFulfilled),
  };
  return chain;
}

function makeAdmin(tables: Tables) {
  return {
    from(table: string) {
      return {
        select: (...args: unknown[]) => makeChain(tables, table).select(...args),
        eq: (col: string, val: unknown) => makeChain(tables, table).eq(col, val),
        gte: (col: string, val: unknown) => makeChain(tables, table).gte(col, val),
        lte: (col: string, val: unknown) => makeChain(tables, table).lte(col, val),
        is: (col: string, val: unknown) => makeChain(tables, table).is(col, val),
        not: (col: string, op: string, val: unknown) => makeChain(tables, table).not(col, op, val),
        in: (col: string, val: unknown[]) => makeChain(tables, table).in(col, val),
        insert: async (row: Row | Row[]) => {
          const arr = tables[table] ?? (tables[table] = []);
          if (Array.isArray(row)) arr.push(...row);
          else arr.push(row);
          return { data: null, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof evaluateMediaBuyerTestPublish>[0];
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const WS = "ws-1";
const ACCT = "acct-A";
const TEST_ADSET = "6100000000001";
const OTHER_ADSET = "6100000000999";
const CEILING_CENTS = 50000; // $500/day test ceiling

function cohortRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "cohort-1",
    workspace_id: WS,
    meta_ad_account_id: null,
    test_meta_adset_id: TEST_ADSET,
    daily_test_ceiling_cents: CEILING_CENTS,
    is_active: true,
    notes: null,
    updated_by: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

// ── Branch 1: in-adset + under-cap → ALLOW (live) ────────────────────────────

test("evaluateMediaBuyerTestPublish — in-adset + under-cap → ALLOW (publish live)", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [cohortRow()],
    dashboard_notifications: [],
    director_activity: [],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: TEST_ADSET,
    projectedDailyCents: CEILING_CENTS, // exactly at the cap — allowed
  });
  assert.equal(r.allowed, true);
  if (r.allowed) {
    assert.equal(r.cohort.testMetaAdsetId, TEST_ADSET);
    assert.equal(r.ceilingCents, CEILING_CENTS);
    assert.equal(r.projectedDailyCents, CEILING_CENTS);
  }
});

// ── Branch 2: wrong adset → REFUSE + escalate ────────────────────────────────

test("evaluateMediaBuyerTestPublish — wrong ad set → REFUSE with reason='wrong_adset'", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [cohortRow()],
    dashboard_notifications: [],
    director_activity: [],
  };
  const admin = makeAdmin(tables);
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: OTHER_ADSET, // != configured test ad set
    projectedDailyCents: 10000, // way under the cap but doesn't matter
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "wrong_adset");
    assert.ok(r.diagnosis.includes(OTHER_ADSET));
    assert.ok(r.diagnosis.includes(TEST_ADSET));
    // Simulate the caller: publish PAUSED + escalate.
    const esc = await escalateMediaBuyerTestPublishRefusal(admin, {
      workspaceId: WS,
      metaAdsetId: OTHER_ADSET,
      metaAdAccountId: null,
      projectedDailyCents: r.projectedDailyCents,
      reason: r.reason,
      diagnosis: r.diagnosis,
      ceilingCents: r.ceilingCents,
      jobId: "job-1",
      campaignId: "campaign-1",
    });
    assert.equal(esc.emitted, true);
  }

  // One CEO-routed approval-request notification + two director_activity rows
  // (platform's `escalated` from escalateDiagnosisToCeo + growth's `media_buyer_test_gate_refused`).
  const notifs = tables.dashboard_notifications ?? [];
  assert.equal(notifs.length, 1);
  const meta = (notifs[0].metadata ?? {}) as Record<string, unknown>;
  assert.equal(meta.escalation_kind, "media_buyer_test_gate_refused");
  assert.equal(meta.dedupe_key, `media_buyer_test_gate:${WS}:${OTHER_ADSET}:wrong_adset`);

  const activity = tables.director_activity ?? [];
  assert.equal(activity.length, 2);
  const growthRow = activity.find((a) => a.director_function === "growth");
  assert.ok(growthRow, "expected a growth-owned director_activity row");
  assert.equal(growthRow!.action_kind, "media_buyer_test_gate_refused");
  const gm = (growthRow!.metadata ?? {}) as Record<string, unknown>;
  assert.equal(gm.origin, MEDIA_BUYER_TEST_ORIGIN);
  assert.equal(gm.reason, "wrong_adset");
  assert.equal(gm.meta_adset_id, OTHER_ADSET);
});

// ── Branch 3: right adset, over the ceiling → REFUSE + escalate ──────────────

test("evaluateMediaBuyerTestPublish — over ceiling → REFUSE with reason='over_ceiling'", async () => {
  const tables: Tables = {
    media_buyer_test_cohorts: [cohortRow()],
    dashboard_notifications: [],
    director_activity: [],
  };
  const admin = makeAdmin(tables);
  const over = CEILING_CENTS + 1; // one cent over the cap
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: TEST_ADSET,
    projectedDailyCents: over,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "over_ceiling");
    assert.equal(r.ceilingCents, CEILING_CENTS);
    assert.equal(r.projectedDailyCents, over);
    const esc = await escalateMediaBuyerTestPublishRefusal(admin, {
      workspaceId: WS,
      metaAdsetId: TEST_ADSET,
      metaAdAccountId: null,
      projectedDailyCents: r.projectedDailyCents,
      reason: r.reason,
      diagnosis: r.diagnosis,
      ceilingCents: r.ceilingCents,
    });
    assert.equal(esc.emitted, true);
  }

  const notifs = tables.dashboard_notifications ?? [];
  assert.equal(notifs.length, 1);
  const meta = (notifs[0].metadata ?? {}) as Record<string, unknown>;
  assert.equal(meta.dedupe_key, `media_buyer_test_gate:${WS}:${TEST_ADSET}:over_ceiling`);
  // ceoEscalationNotification carries a fixed set of keys (routed_to_function, escalation_kind,
  // escalation_reason, dedupe_key, deep_link, spec_slug, approve_action_id) — the per-breach
  // detail (projected / ceiling) lives on the growth-owned director_activity row, checked below.
  assert.equal(meta.escalation_kind, "media_buyer_test_gate_refused");

  const activity = tables.director_activity ?? [];
  const growthRow = activity.find((a) => a.director_function === "growth");
  assert.ok(growthRow);
  const gm = (growthRow!.metadata as Record<string, unknown>);
  assert.equal(gm.reason, "over_ceiling");
  assert.equal(gm.projected_daily_cents, over);
  assert.equal(gm.ceiling_cents, CEILING_CENTS);
});

// ── Branch 4 (bonus — the un-configured case) ───────────────────────────────

test("evaluateMediaBuyerTestPublish — no active cohort → REFUSE with reason='no_active_cohort'", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [], // empty
    dashboard_notifications: [],
    director_activity: [],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: TEST_ADSET,
    projectedDailyCents: 10000,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "no_active_cohort");
    assert.equal(r.cohort, null);
    assert.equal(r.ceilingCents, null);
  }
});

// ── Bonus: dormant (inactive) cohort is NOT considered ───────────────────────

test("evaluateMediaBuyerTestPublish — inactive cohort is skipped (treated as no_active_cohort)", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [cohortRow({ is_active: false })],
    dashboard_notifications: [],
    director_activity: [],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: TEST_ADSET,
    projectedDailyCents: CEILING_CENTS,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "no_active_cohort");
});

// ── Bonus: per-account row beats workspace-wide row for the same workspace ──

test("getEffectiveMediaBuyerTestCohort — per-account row beats workspace-wide row", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      cohortRow({ id: "workspace-wide", meta_ad_account_id: null, test_meta_adset_id: "wide" }),
      cohortRow({ id: "per-account", meta_ad_account_id: ACCT, test_meta_adset_id: TEST_ADSET }),
    ],
  });
  // Per-account request hits the per-account cohort.
  const perAccount = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    metaAdsetId: TEST_ADSET,
    projectedDailyCents: CEILING_CENTS,
  });
  assert.equal(perAccount.allowed, true);
  // Workspace-wide request still hits the workspace-wide cohort — different adset id.
  const wide = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: null,
    metaAdsetId: "wide",
    projectedDailyCents: CEILING_CENTS,
  });
  assert.equal(wide.allowed, true);
});

// ── Product dimension (media-buyer-product-scoped-test-rail Phase 1) ────────

test("getEffectiveMediaBuyerTestCohort — two active cohorts in one account under different products both resolve; missing-product falls back to the null-product account default", async () => {
  // Two products share ACCT — Amazing Coffee + Creamer today, each with its own
  // adset + ceiling — and a null-product account default plays the role of the
  // fallback for any product that doesn't have its own row (e.g. Superfood Tabs
  // when they're wired into a shared account, or a not-yet-configured product).
  const PRODUCT_A = "prod-A";
  const PRODUCT_B = "prod-B";
  const PRODUCT_C = "prod-C-missing"; // no row for this product
  const ADSET_A = "6100000000A";
  const ADSET_B = "6100000000B";
  const ADSET_DEFAULT = "6100000000D";
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      cohortRow({
        id: "acct-a-product-a",
        meta_ad_account_id: ACCT,
        product_id: PRODUCT_A,
        test_meta_adset_id: ADSET_A,
      }),
      cohortRow({
        id: "acct-a-product-b",
        meta_ad_account_id: ACCT,
        product_id: PRODUCT_B,
        test_meta_adset_id: ADSET_B,
      }),
      cohortRow({
        id: "acct-a-null-product-default",
        meta_ad_account_id: ACCT,
        product_id: null,
        test_meta_adset_id: ADSET_DEFAULT,
      }),
    ],
  });

  // Both product-specific rows are active + resolvable (the new unique index
  // permits one active row per (workspace, account, product)) — they never
  // collide with each other.
  const forA = await getEffectiveMediaBuyerTestCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
  });
  assert.ok(forA, "expected an active cohort for (ACCT, PRODUCT_A)");
  assert.equal(forA!.id, "acct-a-product-a");
  assert.equal(forA!.productId, PRODUCT_A);
  assert.equal(forA!.testMetaAdsetId, ADSET_A);

  const forB = await getEffectiveMediaBuyerTestCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_B,
  });
  assert.ok(forB, "expected an active cohort for (ACCT, PRODUCT_B)");
  assert.equal(forB!.id, "acct-a-product-b");
  assert.equal(forB!.productId, PRODUCT_B);
  assert.equal(forB!.testMetaAdsetId, ADSET_B);

  // A product with NO row for this account resolves to the null-product account
  // default — never to another product's row (anti-cross-contamination + the
  // Superfood-Tabs-preserved-shape claim in the spec).
  const forC = await getEffectiveMediaBuyerTestCohort(admin, WS, {
    metaAdAccountId: ACCT,
    productId: PRODUCT_C,
  });
  assert.ok(forC, "expected the null-product account default to catch a missing product");
  assert.equal(forC!.id, "acct-a-null-product-default");
  assert.equal(forC!.productId, null);
  assert.equal(forC!.testMetaAdsetId, ADSET_DEFAULT);
});

test("Phase 2 — evaluateMediaBuyerTestPublish routes the ceiling read to the product-specific cohort: a projected daily OVER A's ceiling REFUSES over_ceiling; the same amount UNDER B's separate ceiling ALLOWS", async () => {
  // Amazing Coffee + Creamer share one Meta ad account today. Each product has
  // its own adset + ceiling; the anti-cross-contamination guard says the ceiling
  // read must land on the product-specific cohort, not the null-product default.
  const PRODUCT_A = "prod-A";
  const PRODUCT_B = "prod-B";
  const ADSET_A = "6100000000A";
  const ADSET_B = "6100000000B";
  const CEIL_A = 40000; // $400/day
  const CEIL_B = 80000; // $800/day
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      cohortRow({
        id: "cohort-A",
        meta_ad_account_id: ACCT,
        product_id: PRODUCT_A,
        test_meta_adset_id: ADSET_A,
        daily_test_ceiling_cents: CEIL_A,
      }),
      cohortRow({
        id: "cohort-B",
        meta_ad_account_id: ACCT,
        product_id: PRODUCT_B,
        test_meta_adset_id: ADSET_B,
        daily_test_ceiling_cents: CEIL_B,
      }),
    ],
    dashboard_notifications: [],
    director_activity: [],
  });

  // A projected $500/day — ABOVE A's $400 ceiling — is refused for product A.
  const projected = 50000;
  const refuseA = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: PRODUCT_A,
    metaAdsetId: ADSET_A,
    projectedDailyCents: projected,
  });
  assert.equal(refuseA.allowed, false);
  if (!refuseA.allowed) {
    assert.equal(refuseA.reason, "over_ceiling");
    assert.equal(refuseA.ceilingCents, CEIL_A);
    assert.equal(refuseA.projectedDailyCents, projected);
    // Absolute proof the read landed on A's cohort — not the null-product default.
    assert.equal(refuseA.cohort?.productId, PRODUCT_A);
  }

  // The SAME projected $500/day — UNDER B's $800 ceiling — is allowed for product B,
  // in the same account. B's cohort is a separate row with its own ceiling.
  const allowB = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: PRODUCT_B,
    metaAdsetId: ADSET_B,
    projectedDailyCents: projected,
  });
  assert.equal(allowB.allowed, true);
  if (allowB.allowed) {
    assert.equal(allowB.ceilingCents, CEIL_B);
    assert.equal(allowB.projectedDailyCents, projected);
    assert.equal(allowB.cohort.productId, PRODUCT_B);
  }
});

test("getEffectiveMediaBuyerTestCohort — omitting productId (or passing null) preserves the pre-product-scoped resolution (null-product account default)", async () => {
  // Superfood Tabs today: no product dimension on the caller. The resolver must
  // return the null-product account default so nothing regresses.
  const PRODUCT_A = "prod-A";
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      cohortRow({
        id: "acct-a-product-a",
        meta_ad_account_id: ACCT,
        product_id: PRODUCT_A,
        test_meta_adset_id: "adset-A",
      }),
      cohortRow({
        id: "acct-a-null-product-default",
        meta_ad_account_id: ACCT,
        product_id: null,
        test_meta_adset_id: "adset-default",
      }),
    ],
  });
  const noProduct = await getEffectiveMediaBuyerTestCohort(admin, WS, {
    metaAdAccountId: ACCT,
  });
  assert.ok(noProduct);
  assert.equal(noProduct!.id, "acct-a-null-product-default");
  assert.equal(noProduct!.productId, null);
});

// ── Per-test-adset cohort (CEO 2026-07-12) ──────────────────────────────────
// adsetPerTest cohorts mint a fresh $150 ad set per creative — no single shared adset — so the gate
// swaps the wrong_adset identity check for: per-adset budget ≤ per-test, and a concurrency recount
// (live per-test adsets + 1) × per-test ≤ ceiling. $600 ceiling / $150 per-test = 4 concurrent max.

const PT_TEMPLATE = {
  optimizationGoal: "OFFSITE_CONVERSIONS",
  billingEvent: "IMPRESSIONS",
  bidStrategy: "LOWEST_COST_WITHOUT_CAP",
  pixelId: "px-1",
  customEventType: "PURCHASE",
  targeting: { age_min: 18 },
};

function perTestCohortRow(overrides: Partial<Row> = {}): Row {
  return cohortRow({
    id: "pt-cohort",
    meta_ad_account_id: ACCT,
    product_id: "prod-PT",
    test_meta_adset_id: null, // per-test cohorts have no shared adset
    adset_per_test: true,
    test_meta_campaign_id: "camp-PT",
    per_test_daily_budget_cents: 15000, // $150
    daily_test_ceiling_cents: 60000, // $600 → 4 concurrent
    adset_template: PT_TEMPLATE,
    ...overrides,
  });
}

/** One live per-test ad set in the cohort's testing campaign — counts toward concurrency now that the
 *  gate reads live `meta_adsets` (ORIGIN-AGNOSTIC, so legacy-loop adsets count too), not `ad_publish_jobs`.
 *  `effective_status` defaults ACTIVE; pass a freed status (PAUSED/…) to prove it does NOT occupy a slot. */
function liveTestAdset(adsetId: string, campaignId = "camp-PT", effectiveStatus = "ACTIVE"): Row {
  return {
    meta_adset_id: adsetId,
    workspace_id: WS,
    meta_campaign_id: campaignId,
    effective_status: effectiveStatus,
  };
}

test("evaluateMediaBuyerTestPublish — per-test cohort, first test (0 live) → ALLOW", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    ad_publish_jobs: [],
    ad_campaigns: [{ id: "camp-live", workspace_id: WS, product_id: "prod-PT" }],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending:job-x", // no adset yet in per-test mode
    projectedDailyCents: 15000, // $150 = the per-test budget
  });
  assert.equal(r.allowed, true);
  if (r.allowed) assert.equal(r.ceilingCents, 60000);
});

test("evaluateMediaBuyerTestPublish — per-test cohort at 3 live (would be the 4th) → ALLOW; at 4 live → over_concurrency", async () => {
  // 3 live → 4th fits exactly ($600).
  const three = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    meta_adsets: [liveTestAdset("a1"), liveTestAdset("a2"), liveTestAdset("a3")],
  });
  const r3 = await evaluateMediaBuyerTestPublish(three, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  assert.equal(r3.allowed, true);

  // 4 live → a 5th would be $750 > $600 → refuse.
  const four = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    meta_adsets: [liveTestAdset("a1"), liveTestAdset("a2"), liveTestAdset("a3"), liveTestAdset("a4")],
    dashboard_notifications: [],
    director_activity: [],
  });
  const r4 = await evaluateMediaBuyerTestPublish(four, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  assert.equal(r4.allowed, false);
  if (!r4.allowed) assert.equal(r4.reason, "over_concurrency");
});

test("evaluateMediaBuyerTestPublish — REGRESSION (2026-07-12 over-launch): pre-existing legacy adsets in the campaign count (any origin), and PAUSED adsets are freed", async () => {
  // The bug: an ad_publish_jobs-only count was blind to 4 pre-existing Coffee adsets (minted by the old
  // loop, no publish-job rows) → the gate saw 0 → over-launched to 8. The campaign has NO ad_publish_jobs
  // rows at all — only live meta_adsets — proving the count is origin-agnostic.
  const atCeiling = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    ad_publish_jobs: [], // deliberately empty — the OLD counter returned 0 here and over-launched
    meta_adsets: [liveTestAdset("legacy1"), liveTestAdset("legacy2"), liveTestAdset("legacy3"), liveTestAdset("legacy4")],
    dashboard_notifications: [],
    director_activity: [],
  });
  const rCeil = await evaluateMediaBuyerTestPublish(atCeiling, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  assert.equal(rCeil.allowed, false); // 4 legacy live → 5th refused (was ALLOWED under the bug)
  if (!rCeil.allowed) assert.equal(rCeil.reason, "over_concurrency");

  // Pausing 3 of those 4 FREES their slots → only 1 occupies → the new one is the 2nd → fits.
  const mostlyPaused = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    meta_adsets: [
      liveTestAdset("legacy1", "camp-PT", "PAUSED"),
      liveTestAdset("legacy2", "camp-PT", "ADSET_PAUSED"),
      liveTestAdset("legacy3", "camp-PT", "CAMPAIGN_PAUSED"),
      liveTestAdset("legacy4"), // the one still ACTIVE
    ],
  });
  const rPaused = await evaluateMediaBuyerTestPublish(mostlyPaused, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  assert.equal(rPaused.allowed, true);
});

test("evaluateMediaBuyerTestPublish — per-test concurrency is campaign-scoped (another product's campaign is excluded)", async () => {
  // Each per-test cohort's test_meta_campaign_id is product-specific, so a live adset in a DIFFERENT
  // campaign (another product's testing campaign) must not count against prod-PT's ceiling.
  const admin = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    meta_adsets: [
      liveTestAdset("a1", "camp-PT"),        // this cohort's campaign
      liveTestAdset("other", "camp-other"),   // another product's campaign — must be excluded
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  // Only 1 counts (a1 in camp-PT) → 2nd fits under $600 → ALLOW.
  assert.equal(r.allowed, true);
});

test("evaluateMediaBuyerTestPublish — per-test adset budget over per-test → over_ceiling", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow()],
    ad_publish_jobs: [],
    ad_campaigns: [],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 20000, // $200 > $150 per-test
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "over_ceiling");
});

test("evaluateMediaBuyerTestPublish — per-test cohort missing template/campaign → cohort_misconfigured", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [perTestCohortRow({ adset_template: null, test_meta_campaign_id: null })],
    ad_publish_jobs: [],
    ad_campaigns: [],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS, metaAdAccountId: ACCT, productId: "prod-PT",
    metaAdsetId: "pending", projectedDailyCents: 15000,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "cohort_misconfigured");
});

// ── Purchaser-exclusion rail (bianca-cold-test-recent-purchaser-exclusion Phase 3) ──
// When the cohort carries `excluded_purchaser_audience_id`, the per-test publish must
// list that id under the proposed adset targeting's `excluded_custom_audiences`, or
// the gate refuses `missing_purchaser_exclusion`. A cohort with a null id (legacy
// pre-Phase-1 row / transition window) SKIPS the check — the existing branches decide.

const AUDIENCE_ID = "23843000000000001";

test("evaluateMediaBuyerTestPublish — per-test cohort with exclusion + spec MISSING id → REFUSE missing_purchaser_exclusion", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      perTestCohortRow({ excluded_purchaser_audience_id: AUDIENCE_ID }),
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending",
    projectedDailyCents: 15000,
    createAdsetSpec: {
      campaign_id: "camp-PT",
      name: "MB test — missing exclusion",
      daily_budget_cents: 15000,
      pixel_id: "px-1",
      custom_event_type: "PURCHASE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      // Deliberately no excluded_custom_audiences at all.
      targeting: { age_min: 50, age_max: 65, geo_locations: { countries: ["US"] } },
    },
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "missing_purchaser_exclusion");
    assert.equal(r.cohort?.excludedPurchaserAudienceId, AUDIENCE_ID);
    // Diagnosis surfaces the audience id so the CEO card names the correct row.
    assert.ok(r.diagnosis.includes(AUDIENCE_ID));
  }
});

test("evaluateMediaBuyerTestPublish — per-test cohort with exclusion + spec CONTAINS id → ALLOW", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      perTestCohortRow({ excluded_purchaser_audience_id: AUDIENCE_ID }),
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending",
    projectedDailyCents: 15000,
    createAdsetSpec: {
      campaign_id: "camp-PT",
      name: "MB test — with exclusion",
      daily_budget_cents: 15000,
      pixel_id: "px-1",
      custom_event_type: "PURCHASE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        age_min: 50,
        age_max: 65,
        geo_locations: { countries: ["US"] },
        // The exact shape the provision path emits.
        excluded_custom_audiences: [{ id: AUDIENCE_ID }],
      },
    },
  });
  assert.equal(r.allowed, true);
  if (r.allowed) {
    assert.equal(r.cohort.excludedPurchaserAudienceId, AUDIENCE_ID);
  }
});

// ── Customer-list exclusion rail (bianca-full-order-history-customer-list-exclusion-audience Fix 1) ──
// Sibling of the purchaser-exclusion rail — second audience id, same shape. When the cohort
// carries `excluded_all_customers_audience_id`, the per-test publish must list THAT id under
// `excluded_custom_audiences` too, or the gate refuses `missing_customer_exclusion`.

const ALL_CUSTOMERS_AUDIENCE_ID = "23843000000000002";

test("evaluateMediaBuyerTestPublish — per-test cohort with all-customers exclusion + spec MISSING id → REFUSE missing_customer_exclusion", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      perTestCohortRow({
        excluded_purchaser_audience_id: null,
        excluded_all_customers_audience_id: ALL_CUSTOMERS_AUDIENCE_ID,
      }),
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending",
    projectedDailyCents: 15000,
    createAdsetSpec: {
      campaign_id: "camp-PT",
      name: "MB test — missing all-customers exclusion",
      daily_budget_cents: 15000,
      pixel_id: "px-1",
      custom_event_type: "PURCHASE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: { age_min: 50, age_max: 65, geo_locations: { countries: ["US"] } },
    },
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "missing_customer_exclusion");
    assert.equal(r.cohort?.excludedAllCustomersAudienceId, ALL_CUSTOMERS_AUDIENCE_ID);
    assert.ok(r.diagnosis.includes(ALL_CUSTOMERS_AUDIENCE_ID));
  }
});

test("evaluateMediaBuyerTestPublish — per-test cohort with BOTH ids + spec carries BOTH → ALLOW", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      perTestCohortRow({
        excluded_purchaser_audience_id: AUDIENCE_ID,
        excluded_all_customers_audience_id: ALL_CUSTOMERS_AUDIENCE_ID,
      }),
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending",
    projectedDailyCents: 15000,
    createAdsetSpec: {
      campaign_id: "camp-PT",
      name: "MB test — with both exclusions",
      daily_budget_cents: 15000,
      pixel_id: "px-1",
      custom_event_type: "PURCHASE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        age_min: 50,
        age_max: 65,
        geo_locations: { countries: ["US"] },
        excluded_custom_audiences: [
          { id: AUDIENCE_ID },
          { id: ALL_CUSTOMERS_AUDIENCE_ID },
        ],
      },
    },
  });
  assert.equal(r.allowed, true);
  if (r.allowed) {
    assert.equal(r.cohort.excludedPurchaserAudienceId, AUDIENCE_ID);
    assert.equal(r.cohort.excludedAllCustomersAudienceId, ALL_CUSTOMERS_AUDIENCE_ID);
  }
});

test("evaluateMediaBuyerTestPublish — per-test cohort with BOTH ids + spec carries ONLY purchaser id → REFUSE missing_customer_exclusion", async () => {
  const admin = makeAdmin({
    media_buyer_test_cohorts: [
      perTestCohortRow({
        excluded_purchaser_audience_id: AUDIENCE_ID,
        excluded_all_customers_audience_id: ALL_CUSTOMERS_AUDIENCE_ID,
      }),
    ],
  });
  const r = await evaluateMediaBuyerTestPublish(admin, {
    workspaceId: WS,
    metaAdAccountId: ACCT,
    productId: "prod-PT",
    metaAdsetId: "pending",
    projectedDailyCents: 15000,
    createAdsetSpec: {
      campaign_id: "camp-PT",
      name: "MB test — purchaser only",
      daily_budget_cents: 15000,
      pixel_id: "px-1",
      custom_event_type: "PURCHASE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      targeting: {
        age_min: 50,
        age_max: 65,
        geo_locations: { countries: ["US"] },
        excluded_custom_audiences: [{ id: AUDIENCE_ID }],
      },
    },
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) {
    assert.equal(r.reason, "missing_customer_exclusion");
    assert.ok(r.diagnosis.includes(ALL_CUSTOMERS_AUDIENCE_ID));
  }
});
