/**
 * selection-engine tests — pin the Phase-1 ledger readers' contract:
 *   (i)   a combination whose `last_used_at` is inside the ~45-day cooldown is excluded
 *   (ii)  a combination whose angle is retired (not returned by the fresh-status palette
 *         SDK read) is excluded
 *   (iii) `readLiveBinThemeDistribution` counts each `creative_theme` stamp exactly once
 *
 * Stubs at the admin.from(...) layer so the real angle-palette / headline-patterns
 * SDK filters run through — same shape as select-angle-pattern.test.ts.
 *
 * Run: npx tsx --test src/lib/ads/selection-engine.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  COOLDOWN_DAYS,
  EXPLOIT_LOOKBACK_DAYS,
  isPastCooldown,
  listEligibleCombinations,
  pickExploitCombination,
  rankSignificancePassedByRoas,
  readLiveBinThemeDistribution,
} from "./selection-engine";
import type { CombinationRollupRow } from "./factor-rollup-sdk";

/**
 * Build the `admin.from(table).select().eq()....` chain shape the palette / pattern /
 * combinations SDKs exercise. Terminal await resolves to `{ data, error }` from the
 * rows registered for that table.
 */
function makeFakeAdmin(rowsByTable: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      const result = { data: rows, error: null as null };
      const builder: {
        select: (cols?: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        order: (col: string, opts?: unknown) => typeof builder;
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
        order() {
          return builder;
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
const NOW_MS = Date.parse(NOW_ISO);

const freshAngleRow = {
  id: "angle-fresh",
  workspace_id: "ws-1",
  product_id: "prod-1",
  theme: "beauty",
  problem: "aging skin",
  ingredients: ["collagen"],
  benefit_key: null,
  enemy: "serums",
  mechanism: "drinkable collagen",
  desired_outcome: "smoother skin",
  proof_text: null,
  proof_kind: null,
  evidence_tier: "science_strong",
  backing_review_ids: [],
  search_demand: "high",
  awareness_stages: ["cold", "warm"],
  source: "seeded",
  times_used: 0,
  last_used_at: null,
  status: "fresh",
  is_active: true,
  display_order: 1,
  notes: null,
};

const coldReframePatternRow = {
  id: "pat-reframe",
  slug: "reframe",
  name: "Reframe",
  structure: "[SUBJECT] doesn't need more [ENEMY]. It needs [MECHANISM].",
  awareness_stages: ["cold"],
  consumes: ["subject", "enemy", "mechanism"],
  example: null,
  is_active: true,
  display_order: 1,
};

test("isPastCooldown: null last_used_at is always past cooldown (never shipped)", () => {
  assert.equal(isPastCooldown(null, NOW_ISO), true);
});

test("isPastCooldown: a shot inside the cooldown horizon is NOT past cooldown", () => {
  const insideMs = NOW_MS - (COOLDOWN_DAYS - 1) * 24 * 60 * 60 * 1000;
  assert.equal(isPastCooldown(new Date(insideMs).toISOString(), NOW_ISO), false);
});

test("isPastCooldown: a shot past the cooldown horizon IS past cooldown", () => {
  const pastMs = NOW_MS - (COOLDOWN_DAYS + 1) * 24 * 60 * 60 * 1000;
  assert.equal(isPastCooldown(new Date(pastMs).toISOString(), NOW_ISO), true);
});

test("(i) a combination whose last_used_at is inside the cooldown window is excluded", async () => {
  const insideCooldownIso = new Date(
    NOW_MS - (COOLDOWN_DAYS - 5) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const pastCooldownIso = new Date(
    NOW_MS - (COOLDOWN_DAYS + 5) * 24 * 60 * 60 * 1000,
  ).toISOString();

  const admin = makeFakeAdmin({
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    ad_creative_combinations: [
      {
        id: "combo-recent",
        workspace_id: "ws-1",
        product_id: "prod-1",
        angle_id: "angle-fresh",
        pattern_id: "pat-reframe",
        times_used: 1,
        last_used_at: insideCooldownIso,
        status: "fresh",
        campaign_id: null,
      },
      {
        id: "combo-old",
        workspace_id: "ws-1",
        product_id: "prod-1",
        angle_id: "angle-fresh",
        pattern_id: "pat-reframe",
        times_used: 1,
        last_used_at: pastCooldownIso,
        status: "fresh",
        campaign_id: null,
      },
    ],
  });

  const out = await listEligibleCombinations({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
    nowIso: NOW_ISO,
  });

  const ids = out.map((s) => s.combination.id);
  assert.ok(!ids.includes("combo-recent"), "combo inside cooldown must be excluded");
  assert.ok(ids.includes("combo-old"), "combo past cooldown must be kept");
});

test("(ii) a retired angle's combinations are excluded (palette SDK returns fresh only)", async () => {
  // The palette-SDK read is scoped to status='fresh', so a retired angle simply never
  // appears in the returned set — the combination pointing at it has no match to join
  // against and is silently dropped by the selector.
  const admin = makeFakeAdmin({
    product_angle_palette: [], // simulates the fresh-status query returning zero rows
    ad_headline_patterns: [coldReframePatternRow],
    ad_creative_combinations: [
      {
        id: "combo-orphan",
        workspace_id: "ws-1",
        product_id: "prod-1",
        angle_id: "angle-retired",
        pattern_id: "pat-reframe",
        times_used: 5,
        last_used_at: null,
        status: "fresh",
        campaign_id: null,
      },
    ],
  });

  const out = await listEligibleCombinations({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
    nowIso: NOW_ISO,
  });

  assert.equal(out.length, 0, "combos whose angle is retired must be excluded");
});

test("(iii) theme distribution counts each creative_theme stamp exactly once", async () => {
  const admin = makeFakeAdmin({
    ad_campaigns: [
      { creative_theme: "beauty" },
      { creative_theme: "beauty" },
      { creative_theme: "longevity" },
      { creative_theme: "energy_performance" },
      { creative_theme: null }, // legacy / pre-M1 row — surfaced under the null key
    ],
  });

  const dist = await readLiveBinThemeDistribution({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
  });

  assert.equal(dist.get("beauty"), 2);
  assert.equal(dist.get("longevity"), 1);
  assert.equal(dist.get("energy_performance"), 1);
  assert.equal(dist.get(null), 1, "legacy rows without a stamp surface under the null key");
  assert.equal(
    Array.from(dist.values()).reduce((a, b) => a + b, 0),
    5,
    "each ad_campaigns row is counted exactly once",
  );
});

test("happy path — eligible shot carries the joined angle + pattern + theme", async () => {
  const admin = makeFakeAdmin({
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    ad_creative_combinations: [
      {
        id: "combo-1",
        workspace_id: "ws-1",
        product_id: "prod-1",
        angle_id: "angle-fresh",
        pattern_id: "pat-reframe",
        times_used: 0,
        last_used_at: null,
        status: "fresh",
        campaign_id: null,
      },
    ],
  });

  const out = await listEligibleCombinations({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
    nowIso: NOW_ISO,
  });

  assert.equal(out.length, 1);
  assert.equal(out[0]!.combination.id, "combo-1");
  assert.equal(out[0]!.angle.id, "angle-fresh");
  assert.equal(out[0]!.pattern.slug, "reframe");
  assert.equal(out[0]!.theme, "beauty");
});

// -------------------------------------------------------------------------------------
// Phase 1 of docs/brain/specs/factor-scores-reweight-selection-engine.md — bias the
// picker's exploit slot with significance-gated crowned winners.
// -------------------------------------------------------------------------------------

const highRoasPassRow: CombinationRollupRow = {
  key: "combo-A",
  combination_id: "combo-A",
  angle_id: "angle-fresh",
  pattern_id: "pat-reframe",
  theme: "beauty",
  spend_cents: 40000,
  purchases: 8,
  revenue_cents: 120000,
  sessions: 900,
  roas: 3.0,
  cpa_cents: 5000,
  ctr: 0.02,
  significance: {
    passesGate: true,
    spendCentsThreshold: 20000,
    purchasesThreshold: 5,
  },
};

const midRoasPassRow: CombinationRollupRow = {
  ...highRoasPassRow,
  key: "combo-B",
  combination_id: "combo-B",
  roas: 1.5,
  revenue_cents: 60000,
  purchases: 6,
  spend_cents: 40000,
};

const highRoasFailRow: CombinationRollupRow = {
  ...highRoasPassRow,
  key: "combo-noise",
  combination_id: "combo-noise",
  spend_cents: 5000,
  purchases: 2,
  significance: {
    passesGate: false,
    spendCentsThreshold: 20000,
    purchasesThreshold: 5,
  },
};

test("rankSignificancePassedByRoas: passesGate high-ROAS wins over passesGate mid-ROAS", () => {
  const ranked = rankSignificancePassedByRoas([midRoasPassRow, highRoasPassRow]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]!.combination_id, "combo-A", "high-ROAS wins");
  assert.equal(ranked[1]!.combination_id, "combo-B");
});

test("rankSignificancePassedByRoas: an insignificant high-ROAS row is filtered out (never wins on noise)", () => {
  const ranked = rankSignificancePassedByRoas([highRoasFailRow, midRoasPassRow]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.combination_id, "combo-B", "only the passesGate row survives");
});

test("rankSignificancePassedByRoas: tie-break by purchases desc when ROAS is equal", () => {
  const tieA: CombinationRollupRow = { ...highRoasPassRow, key: "combo-tieA", combination_id: "combo-tieA", roas: 2, purchases: 7 };
  const tieB: CombinationRollupRow = { ...highRoasPassRow, key: "combo-tieB", combination_id: "combo-tieB", roas: 2, purchases: 9 };
  const ranked = rankSignificancePassedByRoas([tieA, tieB]);
  assert.equal(ranked[0]!.combination_id, "combo-tieB", "more purchases wins on ROAS tie");
});

test("pickExploitCombination: passesGate high-ROAS combination is returned with exploitSource='factor_rollup_roas'", async () => {
  const admin = makeFakeAdmin({
    ad_creative_combinations: [
      {
        id: "combo-A",
        workspace_id: "ws-1",
        product_id: "prod-1",
        angle_id: "angle-fresh",
        pattern_id: "pat-reframe",
        times_used: 3,
        last_used_at: null,
        status: "tested",
        campaign_id: null,
      },
    ],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
  });

  const out = await pickExploitCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
    },
    { byCombination: [midRoasPassRow, highRoasPassRow], byTheme: [], byPattern: [] },
  );

  assert.ok(out, "exploit slot returned a pick");
  assert.equal(out!.intent, "exploit");
  assert.equal(out!.exploitSource, "factor_rollup_roas");
  assert.equal(out!.combination.id, "combo-A");
  assert.equal(out!.biasedByFactors.combination_id, "combo-A");
  assert.equal(out!.biasedByFactors.roas, 3.0);
  assert.equal(out!.biasedByFactors.purchases, 8);
  assert.equal(out!.biasedByFactors.spend_cents, 40000);
});

test("pickExploitCombination: cold start (no passesGate rows) falls back to crowned-status pick with exploitSource='palette_status_crown_fallback'", async () => {
  const crownedComboRow = {
    id: "combo-CROWN",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 12,
    last_used_at: null,
    status: "crowned",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [crownedComboRow],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
  });

  const out = await pickExploitCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
    },
    // Rollup has an insignificant row — not enough to pass, so we fall back to crowned.
    { byCombination: [highRoasFailRow], byTheme: [], byPattern: [] },
  );

  assert.ok(out, "cold-start still returns a crowned-status pick");
  assert.equal(out!.intent, "exploit");
  assert.equal(out!.exploitSource, "palette_status_crown_fallback");
  assert.equal(out!.combination.id, "combo-CROWN");
  assert.equal(out!.biasedByFactors.combination_id, "combo-CROWN");
  assert.equal(
    out!.biasedByFactors.roas,
    undefined,
    "no ROAS number to cite on the crown fallback",
  );
});

test("pickExploitCombination: no passesGate rows AND no crowned combinations returns null (caller falls through to fresh sample)", async () => {
  const admin = makeFakeAdmin({
    ad_creative_combinations: [], // no crowned combos
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
  });

  const out = await pickExploitCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
    },
    { byCombination: [], byTheme: [], byPattern: [] },
  );

  assert.equal(out, null, "true cold start yields null so pickNextCombination falls through");
});

test("EXPLOIT_LOOKBACK_DAYS is a named export the picker + tuners can pin to", () => {
  assert.equal(typeof EXPLOIT_LOOKBACK_DAYS, "number");
  assert.ok(EXPLOIT_LOOKBACK_DAYS > 0);
});
