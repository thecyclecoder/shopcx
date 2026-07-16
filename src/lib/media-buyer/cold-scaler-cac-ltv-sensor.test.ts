/**
 * Unit tests for the cold-scaler CAC:LTV sensor — Phase 2 verification
 * (bianca-cold-scaler-campaign-cac-ltv-sensor). Pins:
 *   (a) each band boundary on fixture ratios so the map from
 *       `cacLtvRatio` → `band` is locked before the DB-touching orchestrator
 *       consumes it (red / yellow / green / unknown);
 *   (b) that `computeColdScalerCacLtvSnapshot` DELEGATES the math to the
 *       shared `blendedCacLtvFromTotals` composer (spec Phase 2 checklist —
 *       single source of truth for the CAC:LTV formula);
 *   (c) an in-memory round-trip through `readLatestColdScalerCacLtvSnapshot`
 *       so the reader chokepoint the arming gate consumes is proven.
 *
 * Run:
 *   npm run test:media-buyer-cold-scaler-cac-ltv-sensor
 *   (or: npx tsx --test src/lib/media-buyer/cold-scaler-cac-ltv-sensor.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  blendedCacLtvFromTotals,
  DEFAULT_BLENDED_CAC_LTV_TARGET,
} from "@/lib/blended-cac-ltv";
import {
  computeColdScalerCacLtvSnapshot,
  ratioToBand,
  readLatestColdScalerCacLtvSnapshot,
  runColdScalerCacLtvSensor,
  COLD_SCALER_CAC_LTV_GREEN_MIN,
  COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER,
} from "./cold-scaler-cac-ltv-sensor";

// ── (a) band boundaries via the pure sensor + ratioToBand ─────────────────────

test("ratioToBand — null → 'unknown' regardless of target", () => {
  assert.equal(ratioToBand(null), "unknown");
  assert.equal(ratioToBand(null, 5), "unknown");
});

test("ratioToBand — ratio at/above target → 'green'", () => {
  assert.equal(ratioToBand(COLD_SCALER_CAC_LTV_GREEN_MIN), "green");
  assert.equal(ratioToBand(COLD_SCALER_CAC_LTV_GREEN_MIN + 0.5), "green");
});

test("ratioToBand — ratio in [0.7×target, target) → 'yellow'", () => {
  const yellowFloor = COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER * COLD_SCALER_CAC_LTV_GREEN_MIN;
  assert.equal(ratioToBand(yellowFloor), "yellow");
  assert.equal(ratioToBand(yellowFloor + 0.1), "yellow");
  assert.equal(ratioToBand(COLD_SCALER_CAC_LTV_GREEN_MIN - 0.01), "yellow");
});

test("ratioToBand — ratio below 0.7×target → 'red'", () => {
  const yellowFloor = COLD_SCALER_CAC_LTV_YELLOW_MULTIPLIER * COLD_SCALER_CAC_LTV_GREEN_MIN;
  assert.equal(ratioToBand(yellowFloor - 0.01), "red");
  assert.equal(ratioToBand(0), "red");
  assert.equal(ratioToBand(0.5), "red");
});

test("computeColdScalerCacLtvSnapshot — no new customers → null ratio, band='unknown'", () => {
  const snap = computeColdScalerCacLtvSnapshot({
    spendCents: 100_00,
    newCustomers: 0,
    revenueCents: 0,
    ltvCents: 0,
  });
  assert.equal(snap.cacLtvRatio, null);
  assert.equal(snap.band, "unknown");
  assert.ok(snap.flags.some((f) => /no new customers/.test(f)));
});

test("computeColdScalerCacLtvSnapshot — high LTV, low CAC → 'green'", () => {
  const snap = computeColdScalerCacLtvSnapshot({
    spendCents: 10_000_00,
    newCustomers: 100,
    revenueCents: 50_000_00,
    ltvCents: 60_000, // $600 LTV vs $100 CAC → 6× → green
  });
  // CAC = 10_000_00 / 100 = 10_000 cents ($100). Ratio = 60_000 / 10_000 = 6.
  assert.equal(snap.cacLtvRatio, 6);
  assert.equal(snap.band, "green");
});

test("computeColdScalerCacLtvSnapshot — mid ratio → 'yellow'", () => {
  const snap = computeColdScalerCacLtvSnapshot({
    spendCents: 10_000_00, // $100 CAC over 100 new customers
    newCustomers: 100,
    revenueCents: 15_000_00,
    ltvCents: 25_000, // $250 LTV → 2.5× → yellow (between 2.1 and 3)
  });
  assert.equal(snap.cacLtvRatio, 2.5);
  assert.equal(snap.band, "yellow");
});

test("computeColdScalerCacLtvSnapshot — starved ratio → 'red'", () => {
  const snap = computeColdScalerCacLtvSnapshot({
    spendCents: 10_000_00, // $100 CAC over 100 new customers
    newCustomers: 100,
    revenueCents: 5_000_00,
    ltvCents: 10_000, // $100 LTV → 1× → red (< 2.1)
  });
  assert.equal(snap.cacLtvRatio, 1);
  assert.equal(snap.band, "red");
});

test("computeColdScalerCacLtvSnapshot — target override changes the band", () => {
  // Ratio = 2.5; default target 3 → yellow; lowered target 2 → green.
  const yellow = computeColdScalerCacLtvSnapshot({
    spendCents: 10_000_00,
    newCustomers: 100,
    revenueCents: 15_000_00,
    ltvCents: 25_000,
  });
  assert.equal(yellow.band, "yellow");
  const green = computeColdScalerCacLtvSnapshot({
    spendCents: 10_000_00,
    newCustomers: 100,
    revenueCents: 15_000_00,
    ltvCents: 25_000,
    target: 2,
  });
  assert.equal(green.band, "green");
});

test("computeColdScalerCacLtvSnapshot — forwards extra flags to the snapshot", () => {
  const snap = computeColdScalerCacLtvSnapshot({
    spendCents: 100_00,
    newCustomers: 10,
    revenueCents: 200_00,
    ltvCents: 50_00,
    flags: ["no meta_adsets found under scaler_meta_campaign_id X"],
  });
  assert.ok(
    snap.flags.some((f) => /no meta_adsets found/.test(f)),
    `expected forwarded flag in ${JSON.stringify(snap.flags)}`,
  );
});

// ── (b) delegate — sensor + blendedCacLtvFromTotals produce identical numbers ─

test("computeColdScalerCacLtvSnapshot — delegates the math to blendedCacLtvFromTotals", () => {
  const totals = {
    spendCents: 12_345_00,
    newCustomers: 42,
    revenueCents: 34_567_00,
    ltvCents: 78_900,
  };
  const target = DEFAULT_BLENDED_CAC_LTV_TARGET;

  const snap = computeColdScalerCacLtvSnapshot({ ...totals, target });
  const blended = blendedCacLtvFromTotals({
    blendedSpendCents: totals.spendCents,
    blendedRevenueCents: totals.revenueCents,
    blendedNewCustomers: totals.newCustomers,
    blendedLtvCents: totals.ltvCents,
    windowDays: 7,
    creditAmazonHalo: true,
    countAllNonRenewal: true,
    targetCacLtv: target,
  });

  assert.equal(snap.cacLtvRatio, blended.cacLtvRatio);
  assert.equal(snap.paybackDays, blended.paybackDays);
  assert.deepEqual(snap.flags, blended.flags);
});

// ── (c) reader round-trip against an in-memory admin ─────────────────────────

interface FakeRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  cold_scaler_cohort_id: string;
  iso_week: string;
  evaluated_at: string;
}

function buildMockAdmin(opts: { rows: FakeRow[] }) {
  let selectedRows: FakeRow[] = [];
  let orderColumn: string | null = null;
  let ascending = true;
  let limitN: number | null = null;
  const makeBuilder = () => {
    const b: {
      eq: (col: string, val: unknown) => typeof b;
      order: (col: string, o: { ascending: boolean }) => typeof b;
      limit: (n: number) => typeof b;
      select: (_cols: string) => typeof b;
      maybeSingle: () => Promise<{ data: FakeRow | null; error: null }>;
    } = {
      eq(col, val) {
        selectedRows = selectedRows.filter((r) => r[col] === val);
        return b;
      },
      order(col, o) {
        orderColumn = col;
        ascending = o.ascending;
        return b;
      },
      limit(n) {
        limitN = n;
        return b;
      },
      select(_cols) {
        return b;
      },
      async maybeSingle() {
        if (orderColumn) {
          const key = orderColumn;
          selectedRows = [...selectedRows].sort((a, b_) => {
            const av = String(a[key]);
            const bv = String(b_[key]);
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitN !== null) selectedRows = selectedRows.slice(0, limitN);
        return { data: selectedRows[0] ?? null, error: null };
      },
    };
    return b;
  };
  const admin = {
    from(_table: string) {
      return {
        select(_cols: string) {
          selectedRows = [...opts.rows];
          orderColumn = null;
          ascending = true;
          limitN = null;
          return makeBuilder();
        },
      };
    },
  };
  return admin as unknown as Parameters<typeof readLatestColdScalerCacLtvSnapshot>[0];
}

test("readLatestColdScalerCacLtvSnapshot — returns the newest row by evaluated_at DESC", async () => {
  const rows: FakeRow[] = [
    {
      id: "snap_older",
      workspace_id: "ws-1",
      meta_ad_account_id: null,
      cold_scaler_cohort_id: "cohort-1",
      iso_week: "2026-W27",
      spend_cents: 1_000_00,
      new_customers: 10,
      revenue_cents: 2_000_00,
      ltv_cents: 50_000,
      cac_ltv_ratio: 5,
      payback_days: 30,
      band: "green",
      flags: ["ok"],
      evaluated_at: "2026-07-01T00:00:00Z",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    },
    {
      id: "snap_newer",
      workspace_id: "ws-1",
      meta_ad_account_id: null,
      cold_scaler_cohort_id: "cohort-1",
      iso_week: "2026-W28",
      spend_cents: 2_000_00,
      new_customers: 20,
      revenue_cents: 3_000_00,
      ltv_cents: 60_000,
      cac_ltv_ratio: 6,
      payback_days: 25,
      band: "green",
      flags: ["ok"],
      evaluated_at: "2026-07-08T00:00:00Z",
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    },
  ];
  const admin = buildMockAdmin({ rows });
  const got = await readLatestColdScalerCacLtvSnapshot(admin, {
    workspaceId: "ws-1",
    coldScalerCohortId: "cohort-1",
  });
  assert.ok(got);
  assert.equal(got!.id, "snap_newer");
  assert.equal(got!.isoWeek, "2026-W28");
  assert.equal(got!.cacLtvRatio, 6);
  assert.equal(got!.band, "green");
  assert.equal(got!.spendCents, 2_000_00);
  assert.equal(got!.ltvCents, 60_000);
  assert.deepEqual(got!.flags, ["ok"]);
});

test("readLatestColdScalerCacLtvSnapshot — bigint-as-string columns are normalized to number", async () => {
  const rows: FakeRow[] = [
    {
      id: "snap_str",
      workspace_id: "ws-1",
      meta_ad_account_id: null,
      cold_scaler_cohort_id: "cohort-1",
      iso_week: "2026-W28",
      spend_cents: "1234500",
      new_customers: "42",
      revenue_cents: "3456700",
      ltv_cents: "78900",
      cac_ltv_ratio: "2.5",
      payback_days: "45",
      band: "yellow",
      flags: [],
      evaluated_at: "2026-07-08T00:00:00Z",
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    },
  ];
  const admin = buildMockAdmin({ rows });
  const got = await readLatestColdScalerCacLtvSnapshot(admin, {
    workspaceId: "ws-1",
    coldScalerCohortId: "cohort-1",
  });
  assert.ok(got);
  assert.equal(typeof got!.spendCents, "number");
  assert.equal(got!.spendCents, 1234500);
  assert.equal(typeof got!.cacLtvRatio, "number");
  assert.equal(got!.cacLtvRatio, 2.5);
  assert.equal(got!.paybackDays, 45);
  assert.equal(got!.band, "yellow");
});

test("readLatestColdScalerCacLtvSnapshot — returns null when no row matches", async () => {
  const admin = buildMockAdmin({ rows: [] });
  const got = await readLatestColdScalerCacLtvSnapshot(admin, {
    workspaceId: "ws-1",
    coldScalerCohortId: "missing",
  });
  assert.equal(got, null);
});

// ── (d) orchestrator round-trip — the persisted snapshot round-trips verbatim ──

type MockRow = Record<string, unknown>;

function makeThenableAdmin(initialTables: Record<string, MockRow[]>) {
  const tables: Record<string, MockRow[]> = {};
  for (const [t, rows] of Object.entries(initialTables)) tables[t] = rows.map((r) => ({ ...r }));
  let idCounter = 0;

  type FilterKind = "eq" | "in" | "is" | "gte" | "lte";
  interface Filter { kind: FilterKind; col: string; val: unknown }
  interface BuilderState {
    op: "select" | "insert" | "update" | "delete";
    filters: Filter[];
    orderBy: { col: string; ascending: boolean } | null;
    limitN: number | null;
    payload: MockRow | MockRow[] | null;
  }

  function applyFilters(rows: MockRow[], filters: Filter[]): MockRow[] {
    let result = [...rows];
    for (const f of filters) {
      if (f.kind === "eq") result = result.filter((r) => r[f.col] === f.val);
      else if (f.kind === "in") result = result.filter((r) => (f.val as unknown[]).includes(r[f.col]));
      else if (f.kind === "is") result = result.filter((r) => (r[f.col] ?? null) === f.val);
      else if (f.kind === "gte") result = result.filter((r) => String(r[f.col]) >= String(f.val));
      else if (f.kind === "lte") result = result.filter((r) => String(r[f.col]) <= String(f.val));
    }
    return result;
  }

  function makeBuilder(table: string, initialOp: BuilderState["op"], payload?: MockRow | MockRow[]) {
    const state: BuilderState = {
      op: initialOp,
      filters: [],
      orderBy: null,
      limitN: null,
      payload: payload ?? null,
    };

    async function execute(): Promise<{ data: MockRow[]; error: null }> {
      const store = tables[table] ?? (tables[table] = []);
      const filtered = applyFilters(store, state.filters);

      if (state.op === "insert") {
        const payloadArr = Array.isArray(state.payload)
          ? state.payload
          : [state.payload as MockRow];
        const nowIso = new Date().toISOString();
        const inserted: MockRow[] = payloadArr.map((r) => ({
          id: (r as MockRow).id ?? `mock-${++idCounter}`,
          created_at: (r as MockRow).created_at ?? nowIso,
          updated_at: (r as MockRow).updated_at ?? nowIso,
          ...r,
        }));
        for (const row of inserted) store.push(row);
        return { data: inserted, error: null };
      }
      if (state.op === "update") {
        const patch = state.payload as MockRow;
        for (const row of filtered) {
          Object.assign(row, patch, { updated_at: new Date().toISOString() });
        }
        return { data: filtered, error: null };
      }
      if (state.op === "delete") {
        for (const row of filtered) {
          const idx = store.indexOf(row);
          if (idx >= 0) store.splice(idx, 1);
        }
        return { data: filtered, error: null };
      }
      let result = [...filtered];
      if (state.orderBy) {
        const { col, ascending } = state.orderBy;
        result.sort((a, b_) => {
          const av = String(a[col]);
          const bv = String(b_[col]);
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (state.limitN !== null) result = result.slice(0, state.limitN);
      return { data: result, error: null };
    }

    const b: Record<string, unknown> = {
      select(_cols?: string) {
        return b;
      },
      eq(col: string, val: unknown) {
        state.filters.push({ kind: "eq", col, val });
        return b;
      },
      in(col: string, val: unknown[]) {
        state.filters.push({ kind: "in", col, val });
        return b;
      },
      is(col: string, val: unknown) {
        state.filters.push({ kind: "is", col, val });
        return b;
      },
      gte(col: string, val: unknown) {
        state.filters.push({ kind: "gte", col, val });
        return b;
      },
      lte(col: string, val: unknown) {
        state.filters.push({ kind: "lte", col, val });
        return b;
      },
      order(col: string, opts: { ascending: boolean }) {
        state.orderBy = { col, ascending: opts.ascending };
        return b;
      },
      limit(n: number) {
        state.limitN = n;
        return b;
      },
      async maybeSingle() {
        const r = await execute();
        return { data: r.data[0] ?? null, error: null };
      },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
      catch(onRejected: (r: unknown) => unknown) {
        return execute().catch(onRejected);
      },
      finally(onFinally: () => void) {
        return execute().finally(onFinally);
      },
    };
    return b;
  }

  const admin = {
    from(table: string) {
      return {
        select(cols?: string) {
          const b = makeBuilder(table, "select");
          (b as { select: (c?: string) => unknown }).select(cols);
          return b;
        },
        insert(row: MockRow | MockRow[]) {
          return makeBuilder(table, "insert", row);
        },
        update(row: MockRow) {
          return makeBuilder(table, "update", row);
        },
        delete() {
          return makeBuilder(table, "delete");
        },
      };
    },
  };
  return { admin, tables };
}

test("runColdScalerCacLtvSensor — in-memory orchestrator round-trip persists a snapshot the reader returns verbatim", async () => {
  const workspaceId = "ws-1";
  const coldScalerCohortId = "cohort-1";
  const scalerMetaCampaignId = "CAMPAIGN_X";
  const isoWeek = "2026-W28"; // Mon 2026-07-06 → Sun 2026-07-12
  const now = new Date("2026-07-08T12:00:00Z");
  const injectedLtvCents = 60_000; // $600 per new customer

  const { admin, tables } = makeThenableAdmin({
    media_buyer_cold_scaler_cohorts: [
      {
        id: coldScalerCohortId,
        workspace_id: workspaceId,
        meta_ad_account_id: "acct-A",
        product_id: null,
        scaler_meta_campaign_id: scalerMetaCampaignId,
        daily_scaler_ceiling_cents: 200_000,
        is_active: true,
        notes: null,
        updated_by: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ],
    meta_adsets: [
      {
        workspace_id: workspaceId,
        meta_adset_id: "ADSET_1",
        meta_campaign_id: scalerMetaCampaignId,
      },
    ],
    meta_ads: [
      {
        workspace_id: workspaceId,
        meta_ad_id: "AD_1",
        meta_adset_id: "ADSET_1",
      },
    ],
    meta_attribution_daily: [
      // Two rows inside the ISO-week window → summed to 100000c spend,
      // 300000c revenue, 20 new customers.
      {
        workspace_id: workspaceId,
        meta_ad_id: "AD_1",
        snapshot_date: "2026-07-07",
        attributed_spend_cents: 50_000,
        revenue_cents: 150_000,
        orders: 10,
      },
      {
        workspace_id: workspaceId,
        meta_ad_id: "AD_1",
        snapshot_date: "2026-07-09",
        attributed_spend_cents: 50_000,
        revenue_cents: 150_000,
        orders: 10,
      },
      // A row OUTSIDE the ISO-week window — must NOT be summed.
      {
        workspace_id: workspaceId,
        meta_ad_id: "AD_1",
        snapshot_date: "2026-06-30",
        attributed_spend_cents: 999_999,
        revenue_cents: 999_999,
        orders: 999,
      },
    ],
    media_buyer_cold_scaler_cac_ltv_snapshots: [],
    director_activity: [],
  });

  const adminForOrchestrator = admin as unknown as Parameters<typeof runColdScalerCacLtvSensor>[0];

  const result = await runColdScalerCacLtvSensor(adminForOrchestrator, {
    workspaceId,
    coldScalerCohortId,
    isoWeek,
    now,
    computeLtvCents: async (_admin, args) => {
      // Force a deterministic LTV numerator so the round-trip has no data-layer
      // dependency on `computeBlendedCacLtv`. Push a diagnostic flag so the
      // snapshot's `flags` column captures the test-injected source.
      args.flags.push("ltv: test-injected");
      return injectedLtvCents;
    },
  });

  // CAC = 100000/20 = 5000c ($50). Ratio = 60000/5000 = 12. Band → 'green'.
  assert.equal(result.spendCents, 100_000);
  assert.equal(result.ltvCents, injectedLtvCents);
  assert.equal(result.cacLtvRatio, 12);
  assert.equal(result.band, "green");
  assert.ok(result.snapshotId, "snapshot row id returned");

  // Persisted snapshot row landed in the mock table.
  const persistedRows = tables["media_buyer_cold_scaler_cac_ltv_snapshots"] ?? [];
  assert.equal(persistedRows.length, 1, "exactly one snapshot row upserted");

  const readBack = await readLatestColdScalerCacLtvSnapshot(adminForOrchestrator, {
    workspaceId,
    coldScalerCohortId,
  });
  assert.ok(readBack, "reader returned a row");
  assert.equal(readBack!.workspaceId, workspaceId);
  assert.equal(readBack!.coldScalerCohortId, coldScalerCohortId);
  assert.equal(readBack!.isoWeek, isoWeek);
  assert.equal(readBack!.spendCents, result.spendCents);
  assert.equal(readBack!.newCustomers, 20);
  assert.equal(readBack!.revenueCents, 300_000);
  assert.equal(readBack!.ltvCents, result.ltvCents);
  assert.equal(readBack!.cacLtvRatio, result.cacLtvRatio);
  assert.equal(readBack!.band, result.band);
  assert.ok(
    readBack!.flags.some((f) => f === "ltv: test-injected"),
    `expected injected LTV flag on the snapshot; got ${JSON.stringify(readBack!.flags)}`,
  );
  assert.equal(readBack!.evaluatedAt, now.toISOString());

  // A director_activity row was stamped for the Growth digest + grader.
  const activityRows = tables["director_activity"] ?? [];
  assert.equal(activityRows.length, 1, "exactly one director_activity row stamped");
  assert.equal(activityRows[0].action_kind, "media_buyer_cold_scaler_cac_ltv_snapshot_written");
  assert.equal(activityRows[0].director_function, "growth");
});

test("runColdScalerCacLtvSensor — re-running for the same (cohort, iso_week) upserts in place (compare-and-set)", async () => {
  const workspaceId = "ws-1";
  const coldScalerCohortId = "cohort-1";
  const scalerMetaCampaignId = "CAMPAIGN_X";
  const isoWeek = "2026-W28";
  const now1 = new Date("2026-07-08T12:00:00Z");
  const now2 = new Date("2026-07-08T18:00:00Z");

  const { admin, tables } = makeThenableAdmin({
    media_buyer_cold_scaler_cohorts: [
      {
        id: coldScalerCohortId,
        workspace_id: workspaceId,
        meta_ad_account_id: "acct-A",
        product_id: null,
        scaler_meta_campaign_id: scalerMetaCampaignId,
        daily_scaler_ceiling_cents: 200_000,
        is_active: true,
        notes: null,
        updated_by: null,
        created_at: now1.toISOString(),
        updated_at: now1.toISOString(),
      },
    ],
    meta_adsets: [],
    meta_ads: [],
    meta_attribution_daily: [],
    media_buyer_cold_scaler_cac_ltv_snapshots: [],
    director_activity: [],
  });
  const adminAny = admin as unknown as Parameters<typeof runColdScalerCacLtvSensor>[0];

  await runColdScalerCacLtvSensor(adminAny, {
    workspaceId,
    coldScalerCohortId,
    isoWeek,
    now: now1,
    computeLtvCents: async () => 40_000,
  });
  await runColdScalerCacLtvSensor(adminAny, {
    workspaceId,
    coldScalerCohortId,
    isoWeek,
    now: now2,
    computeLtvCents: async () => 42_000,
  });

  const rows = tables["media_buyer_cold_scaler_cac_ltv_snapshots"];
  assert.equal(rows.length, 1, "compare-and-set — the second run UPDATEs in place, no duplicate row");
  const readBack = await readLatestColdScalerCacLtvSnapshot(adminAny, {
    workspaceId,
    coldScalerCohortId,
  });
  assert.ok(readBack);
  assert.equal(readBack!.ltvCents, 42_000, "newest evaluation wins");
  assert.equal(readBack!.evaluatedAt, now2.toISOString());
});

test("readLatestColdScalerCacLtvSnapshot — a null cac_ltv_ratio surfaces as JS null (never coerced to 0)", async () => {
  const rows: FakeRow[] = [
    {
      id: "snap_unknown",
      workspace_id: "ws-1",
      meta_ad_account_id: null,
      cold_scaler_cohort_id: "cohort-1",
      iso_week: "2026-W28",
      spend_cents: 0,
      new_customers: 0,
      revenue_cents: 0,
      ltv_cents: 0,
      cac_ltv_ratio: null,
      payback_days: null,
      band: "unknown",
      flags: ["no new customers"],
      evaluated_at: "2026-07-08T00:00:00Z",
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    },
  ];
  const admin = buildMockAdmin({ rows });
  const got = await readLatestColdScalerCacLtvSnapshot(admin, {
    workspaceId: "ws-1",
    coldScalerCohortId: "cohort-1",
  });
  assert.ok(got);
  assert.equal(got!.cacLtvRatio, null);
  assert.equal(got!.paybackDays, null);
  assert.equal(got!.band, "unknown");
});
