/**
 * factor-rollup-sdk tests — pin the aggregation + significance-gate contract:
 *   (i)   spend + revenue + purchases are summed per combination / theme / pattern
 *   (ii)  ROAS = revenue / spend (or null when spend=0)
 *   (iii) significance.passesGate flips true ONLY when BOTH spend AND purchases clear
 *         the workspace-tuned thresholds ($200 / 5 purchases default)
 *   (iv)  an ad_campaigns row without a creative_combination_id (unlabelled ad) is
 *         silently excluded — the SDK cannot key an ad it can't match to a bucket
 *   (v)   an empty product (no attribution rows) returns empty arrays, never throws
 *
 * Run: npx tsx --test src/lib/ads/factor-rollup-sdk.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ROLLUP_LOOKBACK_DAYS,
  getFactorRollup,
} from "./factor-rollup-sdk";

function makeFakeAdmin(rowsByTable: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      const result = { data: rows, error: null as null };
      const builder: {
        select: (cols?: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        gte: (col: string, val: unknown) => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        then: <TResult>(
          onFulfilled: (value: { data: unknown[]; error: null }) => TResult,
        ) => Promise<TResult>;
      } = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        gte() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        then(onFulfilled) {
          return Promise.resolve(result).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

const NOW_ISO = "2026-07-22T00:00:00.000Z";

test("(i)+(ii)+(iii) passesGate combination with clear ROAS wins the rank; insignificant row does not", async () => {
  // Combo A: $250 spend / 6 purchases / $500 revenue → passesGate=true, ROAS 2.0
  // Combo B: $50  spend / 2 purchases / $200 revenue → passesGate=false (under $200 & <5 purchases)
  const admin = makeFakeAdmin({
    ad_campaigns: [
      {
        id: "camp-A",
        meta_ad_id: "META-A",
        creative_combination_id: "combo-A",
        angle_palette_id: "angle-A",
        headline_pattern_id: "pat-A",
        creative_theme: "beauty",
      },
      {
        id: "camp-B",
        meta_ad_id: "META-B",
        creative_combination_id: "combo-B",
        angle_palette_id: "angle-B",
        headline_pattern_id: "pat-B",
        creative_theme: "energy_performance",
      },
    ],
    meta_attribution_daily: [
      {
        meta_ad_id: "META-A",
        attributed_spend_cents: 25000,
        sessions: 500,
        orders: 6,
        revenue_cents: 50000,
        snapshot_date: "2026-07-20",
      },
      {
        meta_ad_id: "META-B",
        attributed_spend_cents: 5000,
        sessions: 100,
        orders: 2,
        revenue_cents: 20000,
        snapshot_date: "2026-07-20",
      },
    ],
  });

  const out = await getFactorRollup(admin as never, {
    workspaceId: "ws-1",
    productId: "prod-1",
    nowIso: NOW_ISO,
  });

  assert.equal(out.byCombination.length, 2, "both combinations rolled up");
  const A = out.byCombination.find((r) => r.combination_id === "combo-A")!;
  const B = out.byCombination.find((r) => r.combination_id === "combo-B")!;
  assert.equal(A.significance.passesGate, true, "$250/6-purchase combo passes gate");
  assert.equal(A.roas, 2, "$500 revenue on $250 spend = ROAS 2.0");
  assert.equal(A.purchases, 6);
  assert.equal(A.spend_cents, 25000);
  assert.equal(B.significance.passesGate, false, "$50/2-purchase combo below thresholds");
});

test("(iv) unlabelled ad (no creative_combination_id) is excluded from the rollup", async () => {
  const admin = makeFakeAdmin({
    ad_campaigns: [
      {
        id: "camp-C",
        meta_ad_id: "META-C",
        creative_combination_id: null,
        angle_palette_id: null,
        headline_pattern_id: null,
        creative_theme: null,
      },
    ],
    meta_attribution_daily: [
      {
        meta_ad_id: "META-C",
        attributed_spend_cents: 25000,
        sessions: 500,
        orders: 6,
        revenue_cents: 50000,
        snapshot_date: "2026-07-20",
      },
    ],
  });

  const out = await getFactorRollup(admin as never, {
    workspaceId: "ws-1",
    productId: "prod-1",
    nowIso: NOW_ISO,
  });

  assert.deepEqual(out.byCombination, []);
  assert.deepEqual(out.byTheme, []);
  assert.deepEqual(out.byPattern, []);
});

test("(v) a cold-start product (no attribution rows in the window) returns empty arrays", async () => {
  const admin = makeFakeAdmin({
    ad_campaigns: [
      {
        id: "camp-D",
        meta_ad_id: "META-D",
        creative_combination_id: "combo-D",
        angle_palette_id: "angle-D",
        headline_pattern_id: "pat-D",
        creative_theme: "beauty",
      },
    ],
    meta_attribution_daily: [], // no attribution rows yet
  });

  const out = await getFactorRollup(admin as never, {
    workspaceId: "ws-1",
    productId: "prod-1",
    nowIso: NOW_ISO,
  });

  assert.deepEqual(out.byCombination, []);
  assert.deepEqual(out.byTheme, []);
  assert.deepEqual(out.byPattern, []);
});

test("DEFAULT_ROLLUP_LOOKBACK_DAYS is a named export the picker can pin to", () => {
  assert.equal(typeof DEFAULT_ROLLUP_LOOKBACK_DAYS, "number");
  assert.ok(
    DEFAULT_ROLLUP_LOOKBACK_DAYS > 0,
    "lookback window must be positive",
  );
});
