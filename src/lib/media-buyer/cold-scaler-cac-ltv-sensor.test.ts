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
