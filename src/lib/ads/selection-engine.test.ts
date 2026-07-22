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
  LOSER_CPA_FLOOR_DEFAULT_CENTS,
  PATTERN_FATIGUE_CTR_FLOOR,
  fatiguedPatternsFromRollup,
  isPastCooldown,
  listEligibleCombinations,
  loserCombinationsFromRollup,
  loserThemesFromRollup,
  pickExploitCombination,
  pickFreshCombination,
  pickNextCombination,
  rankSignificancePassedByRoas,
  readLiveBinThemeDistribution,
} from "./selection-engine";
import type {
  CombinationRollupRow,
  FactorRollupOutput,
  FactorRollupRow,
} from "./factor-rollup-sdk";

/**
 * Build the `admin.from(table).select().eq()....` chain shape the palette / pattern /
 * combinations SDKs exercise. Terminal await resolves to `{ data, error }` from the
 * rows registered for that table. Also supports `.insert(payload)` (returns
 * `{data:null, error:null}` and appends to `inserts`) so the Phase-3 audit trail write
 * can be asserted on.
 */
function makeFakeAdmin(rowsByTable: Record<string, unknown[]>) {
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const admin = {
    inserts,
    from(table: string) {
      const rows = rowsByTable[table] ?? [];
      const result = { data: rows, error: null as null };
      const builder: {
        select: (cols?: string) => typeof builder;
        eq: (col: string, val: unknown) => typeof builder;
        gte: (col: string, val: unknown) => typeof builder;
        order: (col: string, opts?: unknown) => typeof builder;
        maybeSingle: () => Promise<{ data: unknown; error: null }>;
        insert: (payload: unknown) => Promise<{ data: null; error: null }>;
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
        order() {
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload) {
          inserts.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        },
        then(onFulfilled) {
          return Promise.resolve(result).then(onFulfilled);
        },
      };
      return builder;
    },
  };
  return admin;
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

// -------------------------------------------------------------------------------------
// Phase 2 of docs/brain/specs/factor-scores-reweight-selection-engine.md — filter
// significance-passed losers from the fresh sample + halve loser-theme quota + exclude
// fatigued patterns.
// -------------------------------------------------------------------------------------

const loserComboRow: CombinationRollupRow = {
  key: "combo-loser",
  combination_id: "combo-loser",
  angle_id: "angle-fresh",
  pattern_id: "pat-reframe",
  theme: "beauty",
  spend_cents: 100000,
  purchases: 6,
  revenue_cents: 40000,
  sessions: 800,
  roas: 0.4,
  cpa_cents: 40000, // $400 — above the $250 loser floor
  ctr: 0.02,
  significance: { passesGate: true, spendCentsThreshold: 20000, purchasesThreshold: 5 },
};

const notPassesGateHighCpaRow: CombinationRollupRow = {
  ...loserComboRow,
  key: "combo-noisy",
  combination_id: "combo-noisy",
  spend_cents: 5000,
  purchases: 2, // below threshold
  cpa_cents: 30000, // above floor BUT not passesGate → NOT excluded
  significance: { passesGate: false, spendCentsThreshold: 20000, purchasesThreshold: 5 },
};

const loserThemeRow: FactorRollupRow = {
  key: "beauty",
  spend_cents: 250000,
  purchases: 8,
  revenue_cents: 100000,
  sessions: 3000,
  roas: 0.4,
  cpa_cents: 31250, // $312.50 above the $250 loser floor
  ctr: 0.02,
  significance: { passesGate: true, spendCentsThreshold: 20000, purchasesThreshold: 5 },
};

const fatiguedPatternRow: FactorRollupRow = {
  key: "pat-fatigued",
  spend_cents: 50000,
  purchases: 5,
  revenue_cents: 60000,
  sessions: 500,
  roas: 1.2,
  cpa_cents: 10000,
  ctr: 0.004, // below 0.008 fatigue floor
  significance: { passesGate: true, spendCentsThreshold: 20000, purchasesThreshold: 5 },
};

test("LOSER_CPA_FLOOR_DEFAULT_CENTS is a named export the fresh branch reads", () => {
  assert.equal(typeof LOSER_CPA_FLOOR_DEFAULT_CENTS, "number");
  assert.ok(LOSER_CPA_FLOOR_DEFAULT_CENTS > 0);
});

test("PATTERN_FATIGUE_CTR_FLOOR is a named export the fresh branch reads", () => {
  assert.equal(typeof PATTERN_FATIGUE_CTR_FLOOR, "number");
  assert.ok(
    PATTERN_FATIGUE_CTR_FLOOR > 0 && PATTERN_FATIGUE_CTR_FLOOR < 1,
    "CTR floor is a fraction",
  );
});

test("loserCombinationsFromRollup: passesGate + cpa above floor → in the set", () => {
  const rollup: FactorRollupOutput = {
    byCombination: [loserComboRow, notPassesGateHighCpaRow],
    byTheme: [],
    byPattern: [],
  };
  const set = loserCombinationsFromRollup(rollup, LOSER_CPA_FLOOR_DEFAULT_CENTS);
  assert.ok(set.has("combo-loser"), "passesGate + high CPA is a loser");
  assert.ok(
    !set.has("combo-noisy"),
    "not-passesGate high CPA is noise, NOT a loser (this is the whole point of the significance gate)",
  );
});

test("loserThemesFromRollup: passesGate + theme cpa above floor → in the set", () => {
  const rollup: FactorRollupOutput = {
    byCombination: [],
    byTheme: [loserThemeRow],
    byPattern: [],
  };
  const set = loserThemesFromRollup(rollup, LOSER_CPA_FLOOR_DEFAULT_CENTS);
  assert.ok(set.has("beauty"), "passesGate theme above floor is halved");
});

test("fatiguedPatternsFromRollup: passesGate + CTR below floor → in the set", () => {
  const rollup: FactorRollupOutput = {
    byCombination: [],
    byTheme: [],
    byPattern: [fatiguedPatternRow],
  };
  const set = fatiguedPatternsFromRollup(rollup);
  assert.ok(set.has("pat-fatigued"), "passesGate low-CTR pattern is fatigued");
});

test("pickFreshCombination: (i) passesGate high-CPA combination is excluded from the fresh sample", async () => {
  const survivorComboRow = {
    id: "combo-survivor",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const loserComboDbRow = {
    ...survivorComboRow,
    id: "combo-loser",
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [loserComboDbRow, survivorComboRow],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    factor_rollup_policies: [],
  });

  const out = await pickFreshCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
      loserCpaFloorCents: LOSER_CPA_FLOOR_DEFAULT_CENTS,
    },
    { byCombination: [loserComboRow], byTheme: [], byPattern: [] },
  );

  assert.ok(out, "fresh branch still returns a pick (the survivor)");
  assert.equal(out!.combination.id, "combo-survivor");
  assert.equal(out!.intent, "explore");
  assert.deepEqual(
    out!.filteredByFactors.combinationLoserExcluded,
    ["combo-loser"],
    "the loser combo is stamped into the audit slot",
  );
  assert.deepEqual(out!.filteredByFactors.patternFatigueExcluded, []);
});

test("pickFreshCombination: (ii) significance-not-passed high-CPA combination is NOT excluded (noise)", async () => {
  const noisyComboRow = {
    id: "combo-noisy",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [noisyComboRow],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    factor_rollup_policies: [],
  });

  const out = await pickFreshCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
      loserCpaFloorCents: LOSER_CPA_FLOOR_DEFAULT_CENTS,
    },
    { byCombination: [notPassesGateHighCpaRow], byTheme: [], byPattern: [] },
  );

  assert.ok(out, "noisy high-CPA row does NOT exclude the combo");
  assert.equal(out!.combination.id, "combo-noisy");
  assert.deepEqual(
    out!.filteredByFactors.combinationLoserExcluded,
    [],
    "significance gate protects noise from filtering",
  );
});

test("pickFreshCombination: (iii) a loser theme has its quota halved AND the picker prefers other themes", async () => {
  const beautyAngle = { ...freshAngleRow, id: "angle-beauty", theme: "beauty" };
  const longevityAngle = {
    ...freshAngleRow,
    id: "angle-longevity",
    theme: "longevity",
  };
  const beautyCombo = {
    id: "combo-beauty",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-beauty",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const longevityCombo = {
    ...beautyCombo,
    id: "combo-longevity",
    angle_id: "angle-longevity",
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [beautyCombo, longevityCombo],
    product_angle_palette: [beautyAngle, longevityAngle],
    ad_headline_patterns: [coldReframePatternRow],
    factor_rollup_policies: [],
  });

  const out = await pickFreshCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
      loserCpaFloorCents: LOSER_CPA_FLOOR_DEFAULT_CENTS,
    },
    {
      byCombination: [],
      byTheme: [loserThemeRow], // 'beauty' is the loser theme
      byPattern: [],
    },
  );

  assert.ok(out, "picker returns a shot even with a loser theme present");
  assert.equal(
    out!.theme,
    "longevity",
    "picker prefers the non-loser theme when both are available",
  );
  assert.deepEqual(
    out!.filteredByFactors.themeQuotaHalved,
    ["beauty"],
    "the loser theme is stamped into the audit slot",
  );
});

test("pickFreshCombination: a fatigued pattern is excluded from the fresh sample", async () => {
  const fatiguedPatternDbRow = {
    ...coldReframePatternRow,
    id: "pat-fatigued",
    slug: "fatigued",
  };
  const combo = {
    id: "combo-1",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-fatigued",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [combo],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [fatiguedPatternDbRow],
    factor_rollup_policies: [],
  });

  const out = await pickFreshCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
      loserCpaFloorCents: LOSER_CPA_FLOOR_DEFAULT_CENTS,
    },
    { byCombination: [], byTheme: [], byPattern: [fatiguedPatternRow] },
  );

  assert.equal(out, null, "fatigued pattern is the only one → no legal shot");
});

// -------------------------------------------------------------------------------------
// Phase 3 of docs/brain/specs/factor-scores-reweight-selection-engine.md — every pick
// writes one director_activity row with kind='media_buyer_selection_reweighted' so a
// founder can retrace which numbers biased the decision (no silent proxy-optimization).
// -------------------------------------------------------------------------------------

test("pickNextCombination: writes one director_activity row per pick with the exploit provenance", async () => {
  const combo = {
    id: "combo-A",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [combo],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    ad_campaigns: [
      {
        id: "camp-A",
        meta_ad_id: "META-A",
        creative_combination_id: "combo-A",
        angle_palette_id: "angle-fresh",
        headline_pattern_id: "pat-reframe",
        creative_theme: "beauty",
      },
    ],
    meta_attribution_daily: [
      {
        meta_ad_id: "META-A",
        attributed_spend_cents: 40000,
        sessions: 900,
        orders: 8,
        revenue_cents: 120000,
        snapshot_date: "2026-07-20",
      },
    ],
    factor_rollup_policies: [],
  });

  const out = await pickNextCombination({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
    rand: () => 0, // pin the exploit branch
    nowIso: NOW_ISO,
  });

  assert.ok(out);
  assert.equal(out!.intent, "exploit");
  const audit = admin.inserts.filter((i) => i.table === "director_activity");
  assert.equal(audit.length, 1, "exactly one audit row per pick");
  const payload = audit[0]!.payload as Record<string, unknown>;
  assert.equal(payload.director_function, "growth");
  assert.equal(payload.action_kind, "media_buyer_selection_reweighted");
  const meta = payload.metadata as Record<string, unknown>;
  assert.equal(meta.product_id, "prod-1");
  assert.equal(meta.intent, "exploit");
  assert.equal(meta.exploit_source, "factor_rollup_roas");
  assert.equal(meta.chosen_combination_id, "combo-A");
  assert.equal(meta.autonomous, true);
});

test("pickNextCombination: fresh-branch pick writes audit row citing the filter/dampen decisions", async () => {
  const combo = {
    id: "combo-fresh",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [combo],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    ad_campaigns: [],
    meta_attribution_daily: [],
    factor_rollup_policies: [],
  });

  const out = await pickNextCombination({
    admin: admin as never,
    workspaceId: "ws-1",
    productId: "prod-1",
    temperature: "cold",
    rand: () => 0.99, // pin the fresh branch
    nowIso: NOW_ISO,
  });

  assert.ok(out);
  assert.equal(out!.intent, "explore");
  const audit = admin.inserts.filter((i) => i.table === "director_activity");
  assert.equal(audit.length, 1);
  const payload = audit[0]!.payload as Record<string, unknown>;
  const meta = payload.metadata as Record<string, unknown>;
  assert.equal(meta.intent, "explore");
  assert.equal(meta.chosen_combination_id, "combo-fresh");
  assert.ok("filtered_by_factors" in meta, "audit row carries the Phase-2 filter slot");
});

test("pickFreshCombination: cold-start rollup (no passesGate rows) → first eligible shot, empty audit arrays", async () => {
  const combo = {
    id: "combo-cold",
    workspace_id: "ws-1",
    product_id: "prod-1",
    angle_id: "angle-fresh",
    pattern_id: "pat-reframe",
    times_used: 0,
    last_used_at: null,
    status: "fresh",
    campaign_id: null,
  };
  const admin = makeFakeAdmin({
    ad_creative_combinations: [combo],
    product_angle_palette: [freshAngleRow],
    ad_headline_patterns: [coldReframePatternRow],
    factor_rollup_policies: [],
  });

  const out = await pickFreshCombination(
    {
      admin: admin as never,
      workspaceId: "ws-1",
      productId: "prod-1",
      temperature: "cold",
      nowIso: NOW_ISO,
      loserCpaFloorCents: LOSER_CPA_FLOOR_DEFAULT_CENTS,
    },
    { byCombination: [], byTheme: [], byPattern: [] },
  );

  assert.ok(out);
  assert.equal(out!.combination.id, "combo-cold");
  assert.deepEqual(out!.filteredByFactors.combinationLoserExcluded, []);
  assert.deepEqual(out!.filteredByFactors.themeQuotaHalved, []);
  assert.deepEqual(out!.filteredByFactors.patternFatigueExcluded, []);
});
