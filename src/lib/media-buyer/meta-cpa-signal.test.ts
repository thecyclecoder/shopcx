/**
 * Unit tests for bianca-loser-kill-excludes-cold-scaler-adsets-plus-7day-grace Phase 1 —
 * `detectMetaCpaLosers` must EXCLUDE any adset whose parent campaign is an
 * ACTIVE cold-scaler cohort's `scaler_meta_campaign_id`. A scaler is governed
 * by cold-scaler logic, not the test decision-tree; confirmed on live
 * Ashwavana Zen Relax scaler adset 120249611797950682: pre-fix its ~$500
 * spend / 0 purchases matched the test early-dud rule and Bianca paused it
 * twice on 2026-07-25 / 07-26. The fix filters cold-scaler campaign adsets
 * out of the loser candidate set.
 *
 * Run:
 *   npx tsx --test src/lib/media-buyer/meta-cpa-signal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectMetaCpaLosers, hasLiveDeliveringAdsets, type MetaCpaLoserOptions } from "./meta-cpa-signal";

type MockRow = Record<string, unknown>;
type FilterKind = "eq" | "in" | "gte";
interface Filter { kind: FilterKind; col: string; val: unknown }

function applyFilters(rows: MockRow[], filters: Filter[]): MockRow[] {
  let result = [...rows];
  for (const f of filters) {
    if (f.kind === "eq") result = result.filter((r) => r[f.col] === f.val);
    else if (f.kind === "in") result = result.filter((r) => (f.val as unknown[]).includes(r[f.col]));
    else if (f.kind === "gte") result = result.filter((r) => String(r[f.col]) >= String(f.val));
  }
  return result;
}

function makeAdmin(tables: Record<string, MockRow[]>) {
  function makeBuilder(table: string) {
    const filters: Filter[] = [];
    let orderBy: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    async function execute(): Promise<{ data: MockRow[]; error: null }> {
      let result = applyFilters(tables[table] ?? [], filters);
      if (orderBy) {
        const { col, ascending } = orderBy;
        result.sort((a, b_) => {
          const av = String(a[col]);
          const bv = String(b_[col]);
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) result = result.slice(0, limitN);
      return { data: result, error: null };
    }

    const b: Record<string, unknown> = {
      select(_cols?: string) { return b; },
      eq(col: string, val: unknown) { filters.push({ kind: "eq", col, val }); return b; },
      in(col: string, val: unknown[]) { filters.push({ kind: "in", col, val }); return b; },
      gte(col: string, val: unknown) { filters.push({ kind: "gte", col, val }); return b; },
      order(col: string, opts: { ascending: boolean }) { orderBy = { col, ascending: opts.ascending }; return b; },
      limit(n: number) { limitN = n; return b; },
      async maybeSingle() { const r = await execute(); return { data: r.data[0] ?? null, error: null }; },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };
    return b;
  }
  return {
    from(table: string) {
      const initial = makeBuilder(table);
      return initial as unknown as Record<string, unknown>;
    },
  } as unknown as Parameters<typeof detectMetaCpaLosers>[0];
}

const WS = "ws-1";
const ACC = "act_123";
const SCALER_CAMP = "camp_scaler_ashwavana";
const SCALER_ADSET = "as_scaler_ashwavana";
const SNAP = "2026-07-27";

const opts: MetaCpaLoserOptions = {
  workspaceId: WS,
  metaAdAccountId: ACC,
  earlyTrimMinSpendCents: 20_000, // $200
  trimMaxCostPerAtcCents: 8_000,
  trimMaxCpmCents: 10_000,
  crownMaxCpaCents: 15_000,
  holdBandMaxCpaCents: 22_000,
  crownMinSpendCents: 45_000,
  crownMinPurchases: 8,
  maxTestSpendCents: 120_000,
  slowKillMinSpendCents: 60_000,
  slowKillMaxCpaCents: 30_000,
};

// Fixture body — a scaler adset spending $502 with 0 purchases (the exact
// Ashwavana Zen Relax shape) that WITHOUT the cold-scaler exclusion trips
// the test early-dud rule (spend ≥ earlyTrimMinSpendCents AND purchases 0).
function fixture(withColdScalerCohort: boolean): Record<string, MockRow[]> {
  return {
    iteration_scorecards_daily: [
      {
        id: "sc-1",
        object_id: SCALER_ADSET,
        label: "Ashwavana Zen Relax scaler",
        workspace_id: WS,
        meta_ad_account_id: ACC,
        level: "adset",
        effective_status: "ACTIVE",
        snapshot_date: SNAP,
        atc_rate: null,
      },
    ],
    meta_insights_daily: [
      {
        workspace_id: WS,
        meta_ad_account_id: ACC,
        level: "adset",
        meta_object_id: SCALER_ADSET,
        snapshot_date: SNAP,
        spend_cents: 50_272,
        purchases: 0,
        revenue_cents: 0,
        impressions: 10_000,
        clicks: 200,
        add_to_cart: 5, // ATC signal present so accountHasAtc = true
      },
    ],
    media_buyer_cold_scaler_cohorts: withColdScalerCohort
      ? [
          {
            id: "cohort-1",
            workspace_id: WS,
            meta_ad_account_id: ACC,
            product_id: null,
            scaler_meta_campaign_id: SCALER_CAMP,
            daily_scaler_ceiling_cents: 200_000,
            is_active: true,
            notes: null,
            updated_by: null,
            created_at: "2026-07-20T00:00:00Z",
            updated_at: "2026-07-20T00:00:00Z",
          },
        ]
      : [],
    meta_adsets: [
      { workspace_id: WS, meta_adset_id: SCALER_ADSET, meta_campaign_id: SCALER_CAMP },
    ],
    meta_ads: [
      { workspace_id: WS, meta_ad_id: "ad-1", meta_adset_id: SCALER_ADSET },
    ],
  };
}

test("Phase 1 positive control — WITHOUT an active cold-scaler cohort, a scaler-shape adset ($502 spend, 0 purchases) IS flagged as a loser (proves the test early-dud rule fires on this shape)", async () => {
  const admin = makeAdmin(fixture(/*withColdScalerCohort*/ false));
  const losers = await detectMetaCpaLosers(admin, opts);
  assert.equal(losers.length, 1, `expected 1 loser without exclusion, got ${losers.length}`);
  assert.equal(losers[0].targetObjectId, SCALER_ADSET);
});

test("Phase 1 pin — WITH an active cold-scaler cohort covering the adset's parent campaign, the same adset is EXCLUDED from detectMetaCpaLosers (the test decision-tree never governs a cold-scaler adset)", async () => {
  const admin = makeAdmin(fixture(/*withColdScalerCohort*/ true));
  const losers = await detectMetaCpaLosers(admin, opts);
  assert.equal(losers.length, 0, `expected 0 losers with cold-scaler exclusion, got ${losers.length}`);
});

// ── COLD START vs STALE SIGNAL (CEO 2026-08-18) ──────────────────────────────────────────────
// `hasFreshMetaSignal` alone cannot separate two states that need opposite responses: ads running
// with a lagging ingest (go dormant — don't spend against numbers we distrust) versus an account
// with nothing live at all (there is no signal to be stale; refusing is a deadlock, because
// launching is the only thing that can ever produce signal). `hasLiveDeliveringAdsets` is the
// discriminator. Ground truth: account d6d619a5 ("Amazing Coffee & Creamer") went dark 2026-08-08;
// its structure sync stayed current and the scorecard cron kept running for other accounts, yet
// every pass reported "Run the insights/scorecard ingest."
test("hasLiveDeliveringAdsets: an account with an ACTIVE adset is NOT a cold start", async () => {
  const admin = makeAdmin({
    meta_adsets: [
      { workspace_id: WS, meta_ad_account_id: ACC, meta_adset_id: "as_1", effective_status: "ACTIVE" },
    ],
  });
  assert.equal(await hasLiveDeliveringAdsets(admin, WS, ACC), true);
});

test("hasLiveDeliveringAdsets: only PAUSED adsets ⇒ cold start (the launch path must open)", async () => {
  const admin = makeAdmin({
    meta_adsets: [
      { workspace_id: WS, meta_ad_account_id: ACC, meta_adset_id: "as_1", effective_status: "PAUSED" },
      { workspace_id: WS, meta_ad_account_id: ACC, meta_adset_id: "as_2", effective_status: "CAMPAIGN_PAUSED" },
    ],
  });
  assert.equal(await hasLiveDeliveringAdsets(admin, WS, ACC), false);
});

test("hasLiveDeliveringAdsets: no adsets at all ⇒ cold start", async () => {
  assert.equal(await hasLiveDeliveringAdsets(makeAdmin({ meta_adsets: [] }), WS, ACC), false);
});

test("hasLiveDeliveringAdsets: another account's ACTIVE adset does NOT count as ours", async () => {
  const admin = makeAdmin({
    meta_adsets: [
      { workspace_id: WS, meta_ad_account_id: "act_other", meta_adset_id: "as_x", effective_status: "ACTIVE" },
    ],
  });
  assert.equal(await hasLiveDeliveringAdsets(admin, WS, ACC), false);
});
