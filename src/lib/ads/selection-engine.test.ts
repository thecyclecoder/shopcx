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
  isPastCooldown,
  listEligibleCombinations,
  readLiveBinThemeDistribution,
} from "./selection-engine";

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
