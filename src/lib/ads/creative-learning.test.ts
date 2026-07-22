/**
 * creative-learning tests — pin the Phase-3 loader shape:
 *   • loadCreativeLearningWithRollup returns byAngle/byTreatment/bestTreatments
 *     unchanged (the outcomes-ledger memory nextTreatmentFor reads) PLUS a
 *     byCombinationRollup slice sourced from the factor-rollup SDK.
 *
 * Run: npx tsx --test src/lib/ads/creative-learning.test.ts
 *
 * See docs/brain/specs/factor-scores-reweight-selection-engine.md Phase 3.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadCreativeLearningWithRollup } from "./creative-learning";

/** Same fake-admin shape the sibling selection-engine.test.ts uses — reads terminate
 *  on `then` with `{data, error}`; `maybeSingle()` is stubbed for the policies read. */
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

test("loadCreativeLearningWithRollup returns two byCombinationRollup rows from the SDK", async () => {
  const admin = makeFakeAdmin({
    creative_test_outcomes: [
      { angle_key: "collagen restore", treatment: "before_after", outcome: "won" },
      { angle_key: "collagen restore", treatment: "testimonial", outcome: "lost" },
    ],
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
        revenue_cents: 60000,
        snapshot_date: "2026-07-20",
      },
      {
        meta_ad_id: "META-B",
        attributed_spend_cents: 30000,
        sessions: 400,
        orders: 5,
        revenue_cents: 45000,
        snapshot_date: "2026-07-20",
      },
    ],
  });

  const learning = await loadCreativeLearningWithRollup(
    admin as never,
    "ws-1",
    "prod-1",
  );

  assert.equal(
    learning.byCombinationRollup.length,
    2,
    "both combinations surface in the rollup slice",
  );
  const A = learning.byCombinationRollup.find((r) => r.combinationId === "combo-A")!;
  assert.equal(A.roas, 2.4, "combo-A: $600 revenue / $250 spend = ROAS 2.4");
  assert.equal(A.purchases, 6);
  assert.equal(
    A.significance.passesGate,
    true,
    "combo-A clears both spend + purchases thresholds",
  );
  const B = learning.byCombinationRollup.find((r) => r.combinationId === "combo-B")!;
  assert.equal(B.purchases, 5);
  assert.equal(
    B.significance.passesGate,
    true,
    "combo-B just clears both spend + purchases thresholds",
  );

  // Pre-Phase-3 shape is UNCHANGED — nextTreatmentFor callers don't regress.
  assert.ok(learning.byAngle.get("collagen restore"), "byAngle carries the outcomes memory");
  assert.equal(
    learning.byAngle.get("collagen restore")!.won,
    1,
    "won outcome stamped on the angle stat",
  );
  assert.equal(
    learning.byAngle.get("collagen restore")!.lost,
    1,
    "lost outcome stamped on the angle stat",
  );
  assert.ok(learning.bestTreatments.length > 0, "bestTreatments still ranked");
});

test("loadCreativeLearningWithRollup: cold-start product returns an empty rollup slice + empty outcomes", async () => {
  const admin = makeFakeAdmin({
    creative_test_outcomes: [],
    ad_campaigns: [],
    meta_attribution_daily: [],
  });

  const learning = await loadCreativeLearningWithRollup(
    admin as never,
    "ws-1",
    "prod-1",
  );

  assert.deepEqual(learning.byCombinationRollup, []);
  assert.equal(learning.byAngle.size, 0);
});
