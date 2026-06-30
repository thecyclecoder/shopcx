/**
 * Unit tests for the winning-creative detector + amplifier
 * (growth-winning-creative-amplifier Phases 1-2).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:winning-creative-detect
 *   (= tsx --test src/lib/ads/winning-creative-detect.test.ts)
 *
 * Phase 1 coverage: the spec's fixture (two ads above floor + one below → exactly the two top-K
 * winners with their angle joined), the audit assumption check (no AdLibrary import), and the
 * score-cell floors.
 *
 * Phase 2 coverage: the spec's verification fixture (winner spawns ≤ MAX_VARIANTS_PER_WINNER
 * campaigns; two calls in one day at the cap do not exceed MAX_AMPLIFICATIONS_PER_DAY total),
 * plus the variant→archetype normalization and the planner mix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AMPLIFIED_WINNER_ACTION_KIND,
  DEFAULT_MIN_SPEND_CENTS,
  MAX_AMPLIFICATIONS_PER_DAY,
  MAX_VARIANTS_PER_WINNER,
  ROAS_FLOOR_MARGIN,
  amplifyWinner,
  archetypeForVariant,
  detectWinners,
  groupAttributionRows,
  landerTypeForAmplifiedWinner,
  pairAmplifiedWinnerWithLander,
  patchFromWinnerAngle,
  planAmplificationVariants,
  scoreCell,
  type AmplifyWinnerDeps,
  type DetectedWinner,
  type WinnerAttributionRow,
} from "./winning-creative-detect";
import { PAIRED_WINNER_LANDER_ACTION_KIND } from "@/lib/storefront/optimizer-agent";

// ── Fake admin client — supports the chained `.select/.eq/.in/.gte/.lte` SELECT shape that the
// detector uses. Reads are answered out of a small per-table store. No writes. ──────────────────
interface FakeStores {
  meta_attribution_daily: Record<string, unknown>[];
  ad_campaigns: Record<string, unknown>[];
  product_ad_angles: Record<string, unknown>[];
}

interface QueryState {
  table: string;
  filters: { col: string; op: "eq" | "in" | "gte" | "lte"; val: unknown }[];
}

function rowMatches(row: Record<string, unknown>, filters: QueryState["filters"]): boolean {
  for (const f of filters) {
    const v = row[f.col];
    if (f.op === "eq" && v !== f.val) return false;
    if (f.op === "in" && (!Array.isArray(f.val) || !(f.val as unknown[]).includes(v))) return false;
    if (f.op === "gte" && !(typeof v === "string" && typeof f.val === "string" && v >= f.val)) return false;
    if (f.op === "lte" && !(typeof v === "string" && typeof f.val === "string" && v <= f.val)) return false;
  }
  return true;
}

function makeChain(stores: FakeStores, table: string) {
  const state: QueryState = { table, filters: [] };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => {
    state.filters.push({ col, op: "eq", val });
    return chain;
  };
  chain.in = (col: string, val: unknown) => {
    state.filters.push({ col, op: "in", val });
    return chain;
  };
  chain.gte = (col: string, val: unknown) => {
    state.filters.push({ col, op: "gte", val });
    return chain;
  };
  chain.lte = (col: string, val: unknown) => {
    state.filters.push({ col, op: "lte", val });
    return chain;
  };
  chain.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) => {
    const rows = stores[table as keyof FakeStores] ?? [];
    const data = rows.filter((r) => rowMatches(r, state.filters));
    return Promise.resolve({ data, error: null }).then(onFulfilled);
  };
  return chain;
}

function makeAdmin(stores: FakeStores) {
  return {
    from(table: string) {
      return makeChain(stores, table);
    },
  } as unknown as Parameters<typeof detectWinners>[0];
}

// ── groupAttributionRows — the pure grouper ────────────────────────────────────

test("groupAttributionRows sums spend/onsite/sessions by (meta_ad_id, variant) and picks dominant joins", () => {
  const cells = groupAttributionRows([
    { meta_ad_id: "AD-1", variant: "advertorial", ad_campaign_id: "C1", angle_id: "ANG-1", sessions: 50, attributed_spend_cents: 1000, revenue_cents: 4000, snapshot_date: "2026-06-25" },
    { meta_ad_id: "AD-1", variant: "advertorial", ad_campaign_id: "C1", angle_id: "ANG-1", sessions: 30, attributed_spend_cents: 500, revenue_cents: 2000, snapshot_date: "2026-06-26" },
    { meta_ad_id: "AD-1", variant: "(unresolved)", ad_campaign_id: null, angle_id: null, sessions: 9, attributed_spend_cents: 0, revenue_cents: 0, snapshot_date: "2026-06-25" },
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].metaAdId, "AD-1");
  assert.equal(cells[0].variant, "advertorial");
  assert.equal(cells[0].spendCents, 1500);
  assert.equal(cells[0].onsiteCents, 6000);
  assert.equal(cells[0].sessions, 80);
  assert.equal(cells[0].adCampaignId, "C1");
  assert.equal(cells[0].angleId, "ANG-1");
});

test("groupAttributionRows excludes `(unresolved)` cells entirely", () => {
  const cells = groupAttributionRows([
    { meta_ad_id: "AD-1", variant: "(unresolved)", ad_campaign_id: null, angle_id: null, sessions: 50, attributed_spend_cents: 1000, revenue_cents: 0, snapshot_date: "2026-06-25" },
  ]);
  assert.equal(cells.length, 0);
});

// ── scoreCell — the pure floor check ───────────────────────────────────────────

test("scoreCell returns null when spend is below the min-spend floor", () => {
  const cell = { metaAdId: "AD-1", variant: "advertorial", spendCents: 100, onsiteCents: 800, sessions: 5, adCampaignId: null, angleId: null };
  assert.equal(scoreCell(cell, { minSpendCents: DEFAULT_MIN_SPEND_CENTS, minRoas: 1, amazonHaloMultiplier: 1 }), null);
});

test("scoreCell returns null when ROAS is below the min-roas floor", () => {
  const cell = { metaAdId: "AD-1", variant: "advertorial", spendCents: 10_000, onsiteCents: 12_000, sessions: 100, adCampaignId: null, angleId: null };
  // ROAS = 1.2, floor = 2.0 → null
  assert.equal(scoreCell(cell, { minSpendCents: 5000, minRoas: 2, amazonHaloMultiplier: 1 }), null);
});

test("scoreCell returns roas + halo-adjusted revenue when both floors clear", () => {
  const cell = { metaAdId: "AD-1", variant: "advertorial", spendCents: 10_000, onsiteCents: 40_000, sessions: 200, adCampaignId: "C1", angleId: "ANG-1" };
  const out = scoreCell(cell, { minSpendCents: 5000, minRoas: 3, amazonHaloMultiplier: 1 });
  assert.deepEqual(out, { roas: 4, haloAdjustedRevenueCents: 40_000 });
});

test("scoreCell applies the Amazon halo multiplier before comparing against the floor", () => {
  const cell = { metaAdId: "AD-1", variant: "advertorial", spendCents: 10_000, onsiteCents: 20_000, sessions: 200, adCampaignId: "C1", angleId: "ANG-1" };
  // Onsite ROAS = 2.0 (below 3 floor); with a 1.6× halo, halo'd ROAS = 3.2 → clears the floor.
  const out = scoreCell(cell, { minSpendCents: 5000, minRoas: 3, amazonHaloMultiplier: 1.6 });
  assert.equal(out?.roas, 3.2);
  assert.equal(out?.haloAdjustedRevenueCents, 32_000);
});

// ── detectWinners — the end-to-end pass against the spec's fixture ─────────────

test("two ads above floor + one below → returns exactly the two top-K winners with their angle joined", async () => {
  // Floor is the default workspace target × 1.2 = 3 × 1.2 = 3.6.
  // AD-WIN-A: spend 20_000, onsite 100_000 → ROAS 5.0 — winner.
  // AD-WIN-B: spend 10_000, onsite 40_000  → ROAS 4.0 — winner.
  // AD-LOSE:  spend 10_000, onsite 30_000  → ROAS 3.0 — below 3.6 floor.
  const stores: FakeStores = {
    meta_attribution_daily: [
      { workspace_id: "ws-1", meta_ad_id: "AD-WIN-A", variant: "advertorial", ad_campaign_id: "C-A", angle_id: "ANG-A", sessions: 800, attributed_spend_cents: 20_000, revenue_cents: 100_000, snapshot_date: "2026-06-25" },
      { workspace_id: "ws-1", meta_ad_id: "AD-WIN-B", variant: "beforeafter", ad_campaign_id: "C-B", angle_id: "ANG-B", sessions: 400, attributed_spend_cents: 10_000, revenue_cents: 40_000, snapshot_date: "2026-06-26" },
      { workspace_id: "ws-1", meta_ad_id: "AD-LOSE", variant: "reasons", ad_campaign_id: "C-X", angle_id: "ANG-X", sessions: 300, attributed_spend_cents: 10_000, revenue_cents: 30_000, snapshot_date: "2026-06-26" },
    ],
    ad_campaigns: [
      { id: "C-A", workspace_id: "ws-1", name: "winning advertorial", product_id: "P-1", variant_id: "V-1", avatar_id: "AV-1", angle_id: "ANG-A", script_text: null, hero_image_url: null, landing_url: null, composition: null, length_sec: 15, scene_style: "outdoor_selfie", caption_style: "hormozi_yellow" },
      { id: "C-B", workspace_id: "ws-1", name: "winning before/after", product_id: "P-1", variant_id: "V-1", avatar_id: "AV-1", angle_id: "ANG-B", script_text: null, hero_image_url: null, landing_url: null, composition: null, length_sec: 15, scene_style: "kitchen_counter", caption_style: "hormozi_yellow" },
      { id: "C-X", workspace_id: "ws-1", name: "below floor", product_id: "P-1", variant_id: "V-1", avatar_id: "AV-1", angle_id: "ANG-X", script_text: null, hero_image_url: null, landing_url: null, composition: null, length_sec: 15, scene_style: "couch", caption_style: "hormozi_yellow" },
    ],
    product_ad_angles: [
      { id: "ANG-A", workspace_id: "ws-1", hook_slug: "problem_now", lf8_slot: 1, lead_benefit_anchor: "sleep deeper", hook_one_liner: "still tired at 3pm?", meta_headline: "Sleep deeper", meta_primary_text: null, meta_description: null },
      { id: "ANG-B", workspace_id: "ws-1", hook_slug: "results_first", lf8_slot: 2, lead_benefit_anchor: "less bloating", hook_one_liner: "flatter in a week", meta_headline: "Flatter in a week", meta_primary_text: null, meta_description: null },
      { id: "ANG-X", workspace_id: "ws-1", hook_slug: "callout", lf8_slot: 3, lead_benefit_anchor: "more energy", hook_one_liner: null, meta_headline: null, meta_primary_text: null, meta_description: null },
    ],
  };

  const admin = makeAdmin(stores);
  const winners = await detectWinners(admin, {
    workspaceId: "ws-1",
    sinceMs: 14 * 86400 * 1000,
    minSpendCents: 5_000,
    nowMs: Date.parse("2026-06-30T00:00:00Z"),
  });

  // Two winners (the third is filtered out by the ROAS floor = 3 × 1.2).
  assert.equal(winners.length, 2);
  // Ordered by ROAS desc.
  assert.equal(winners[0].metaAdId, "AD-WIN-A");
  assert.equal(winners[0].roas, 5);
  assert.equal(winners[0].spendCents, 20_000);
  assert.equal(winners[0].angle?.id, "ANG-A");
  assert.equal(winners[0].angle?.hook_slug, "problem_now");
  assert.equal(winners[0].campaign?.id, "C-A");
  assert.equal(winners[1].metaAdId, "AD-WIN-B");
  assert.equal(winners[1].roas, 4);
  assert.equal(winners[1].angle?.id, "ANG-B");
  // Below-floor ad is absent.
  assert.equal(winners.find((w) => w.metaAdId === "AD-LOSE"), undefined);
  // Audit assumption: the spec mandates the floor margin is exactly 1.2×.
  assert.equal(ROAS_FLOOR_MARGIN, 1.2);
});

test("empty attribution table returns an empty winner list", async () => {
  const stores: FakeStores = { meta_attribution_daily: [], ad_campaigns: [], product_ad_angles: [] };
  const winners = await detectWinners(makeAdmin(stores), {
    workspaceId: "ws-1",
    nowMs: Date.parse("2026-06-30T00:00:00Z"),
  });
  assert.deepEqual(winners, []);
});

// ── Phase 2 — archetypeForVariant + planAmplificationVariants (pure) ─────────────

test("archetypeForVariant normalizes lander-variant slugs to the maker archetype set", () => {
  assert.equal(archetypeForVariant("advertorial"), "advertorial");
  assert.equal(archetypeForVariant("testimonial"), "testimonial");
  assert.equal(archetypeForVariant("before_after"), "before_after");
  assert.equal(archetypeForVariant("before-after"), "before_after");
  assert.equal(archetypeForVariant("beforeafter"), "before_after");
  assert.equal(archetypeForVariant("big-claim"), "big_claim");
  assert.equal(archetypeForVariant("ingredient-breakdown"), "ingredient_breakdown");
  // Unknown variants fall back to testimonial (the safe storefront-PDP archetype).
  assert.equal(archetypeForVariant("reasons"), "testimonial");
  assert.equal(archetypeForVariant("listicle"), "testimonial");
});

test("planAmplificationVariants spawns N statics when the source has no video assets", () => {
  const plan = planAmplificationVariants(
    { scriptText: null, heroImageUrl: null, variant: "advertorial" },
    3,
  );
  assert.equal(plan.length, 3);
  assert.deepEqual(plan, [
    { kind: "static", archetype: "advertorial" },
    { kind: "static", archetype: "advertorial" },
    { kind: "static", archetype: "advertorial" },
  ]);
});

test("planAmplificationVariants picks one video + N-1 statics when the source has script+hero", () => {
  const plan = planAmplificationVariants(
    { scriptText: "hook line", heroImageUrl: "https://x/hero.png", variant: "before_after" },
    4,
  );
  assert.equal(plan.length, 4);
  assert.deepEqual(plan[0], { kind: "video" });
  for (let i = 1; i < plan.length; i += 1) {
    assert.deepEqual(plan[i], { kind: "static", archetype: "before_after" });
  }
});

test("planAmplificationVariants clamps n to MAX_VARIANTS_PER_WINNER", () => {
  const plan = planAmplificationVariants(
    { scriptText: null, heroImageUrl: null, variant: "testimonial" },
    99,
  );
  assert.equal(plan.length, MAX_VARIANTS_PER_WINNER);
});

test("planAmplificationVariants returns [] for n<=0", () => {
  const plan = planAmplificationVariants(
    { scriptText: null, heroImageUrl: null, variant: "testimonial" },
    0,
  );
  assert.deepEqual(plan, []);
});

// ── Phase 2 — amplifyWinner (caps + maker fan-out + activity row) ────────────────

interface AmplifyFakeStores {
  director_activity_today: { metadata: { new_ad_campaign_ids?: unknown[] } | null }[];
  inserted_ad_campaigns: Record<string, unknown>[];
}

interface InsertedRecord { table: string; values: Record<string, unknown>; }

function makeAmplifyAdmin(stores: AmplifyFakeStores) {
  let nextIdCounter = 0;
  const inserts: InsertedRecord[] = [];
  function makeReadChain(rows: unknown[]) {
    const obj: Record<string, unknown> = {};
    obj.select = () => obj;
    obj.eq = () => obj;
    obj.gte = () => obj;
    obj.lte = () => obj;
    obj.in = () => obj;
    obj.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(onFulfilled);
    return obj;
  }
  function makeInsertChain(table: string) {
    const obj: Record<string, unknown> = {};
    let resolved: { data: unknown; error: null } | null = null;
    obj.insert = (values: unknown) => {
      const v = values as Record<string, unknown>;
      inserts.push({ table, values: v });
      if (table === "ad_campaigns") {
        nextIdCounter += 1;
        const id = `camp-${nextIdCounter}`;
        stores.inserted_ad_campaigns.push({ ...v, id });
        resolved = { data: { id }, error: null };
      } else {
        resolved = { data: null, error: null };
      }
      return obj;
    };
    obj.select = () => obj;
    obj.maybeSingle = () => obj;
    obj.single = () => obj;
    obj.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolved ?? { data: null, error: null }).then(onFulfilled);
    return obj;
  }
  const admin = {
    from(table: string) {
      if (table === "director_activity") {
        // SELECT path is used for the daily count read; INSERT path is captured via the deps spy
        // so we never need to chain-route writes through here.
        return makeReadChain(stores.director_activity_today);
      }
      if (table === "ad_campaigns") return makeInsertChain("ad_campaigns");
      return makeInsertChain(table);
    },
  } as unknown as Parameters<typeof amplifyWinner>[0];
  return { admin, inserts };
}

function makeAmplifySpyDeps(): {
  deps: AmplifyWinnerDeps;
  sentInngest: Array<{ name: string; data: unknown }>;
  recordedActivity: Array<Record<string, unknown>>;
} {
  const sentInngest: Array<{ name: string; data: unknown }> = [];
  const recordedActivity: Array<Record<string, unknown>> = [];
  return {
    deps: {
      sendInngest: async (event) => { sentInngest.push(event); return { ids: ["stub"] }; },
      recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    },
    sentInngest,
    recordedActivity,
  };
}

function makeFixtureWinner(over: Partial<DetectedWinner> = {}): DetectedWinner {
  return {
    workspaceId: "ws-1",
    metaAdId: "AD-WIN-A",
    variant: "advertorial",
    spendCents: 20_000,
    onsiteCents: 100_000,
    haloAdjustedRevenueCents: 100_000,
    roas: 5,
    sessions: 800,
    windowStart: "2026-06-16",
    windowEnd: "2026-06-30",
    campaign: {
      id: "C-A",
      name: "winning advertorial",
      product_id: "P-1",
      variant_id: "V-1",
      avatar_id: "AV-1",
      angle_id: "ANG-A",
      script_text: null,
      hero_image_url: null,
      landing_url: "https://shop.example.com/x",
      composition: null,
      length_sec: 15,
      scene_style: "outdoor_selfie",
      caption_style: "hormozi_yellow",
    },
    angle: {
      id: "ANG-A",
      hook_slug: "problem_now",
      lf8_slot: 1,
      lead_benefit_anchor: "sleep deeper",
      hook_one_liner: "still tired at 3pm?",
      meta_headline: "Sleep deeper",
      meta_primary_text: null,
      meta_description: null,
    },
    ...over,
  };
}

test("amplifyWinner spawns ≤ MAX_VARIANTS_PER_WINNER new ad_campaigns + fires the maker + logs one activity row", async () => {
  const stores: AmplifyFakeStores = { director_activity_today: [], inserted_ad_campaigns: [] };
  const { admin } = makeAmplifyAdmin(stores);
  const { deps, sentInngest, recordedActivity } = makeAmplifySpyDeps();

  // Request well over the cap — should clamp to MAX_VARIANTS_PER_WINNER (=4).
  const res = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner: makeFixtureWinner(),
    n: 99,
    specSlug: "growth-winning-creative-amplifier",
    nowMs: Date.parse("2026-06-30T12:00:00Z"),
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.variants_spawned, MAX_VARIANTS_PER_WINNER);
  assert.equal(res.new_ad_campaign_ids.length, MAX_VARIANTS_PER_WINNER);
  assert.equal(stores.inserted_ad_campaigns.length, MAX_VARIANTS_PER_WINNER);
  // Every inserted row lands at status='ready' tagged to the winner's angle.
  for (const r of stores.inserted_ad_campaigns) {
    assert.equal((r as { status: string }).status, "ready");
    assert.equal((r as { angle_id: string }).angle_id, "ANG-A");
    assert.equal((r as { workspace_id: string }).workspace_id, "ws-1");
    assert.equal((r as { product_id: string }).product_id, "P-1");
  }
  // No source video assets → all statics with the advertorial archetype.
  assert.equal(sentInngest.length, MAX_VARIANTS_PER_WINNER);
  for (const e of sentInngest) {
    assert.equal(e.name, "ad-tool/static-requested");
    assert.equal((e.data as { archetype: string }).archetype, "advertorial");
  }
  // ONE activity row stamped per amplification with the spec's metadata shape.
  assert.equal(recordedActivity.length, 1);
  const row = recordedActivity[0] as { actionKind: string; directorFunction: string; metadata: Record<string, unknown> };
  assert.equal(row.actionKind, AMPLIFIED_WINNER_ACTION_KIND);
  assert.equal(row.directorFunction, "growth");
  assert.equal(row.metadata.source_meta_ad_id, "AD-WIN-A");
  assert.equal(row.metadata.angle_id, "ANG-A");
  assert.deepEqual(row.metadata.new_ad_campaign_ids, res.new_ad_campaign_ids);
});

test("amplifyWinner spawns ONE video + (N-1) statics when the source has script_text + hero_image_url", async () => {
  const stores: AmplifyFakeStores = { director_activity_today: [], inserted_ad_campaigns: [] };
  const { admin } = makeAmplifyAdmin(stores);
  const { deps, sentInngest } = makeAmplifySpyDeps();

  const winner = makeFixtureWinner({
    variant: "before-after",
    campaign: {
      id: "C-A",
      name: "video source",
      product_id: "P-1",
      variant_id: "V-1",
      avatar_id: "AV-1",
      angle_id: "ANG-A",
      script_text: "you tried everything…",
      hero_image_url: "https://cdn.example/hero.png",
      landing_url: null,
      composition: null,
      length_sec: 30,
      scene_style: "kitchen_counter",
      caption_style: "hormozi_yellow",
    },
  });

  const res = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner,
    n: 3,
    nowMs: Date.parse("2026-06-30T12:00:00Z"),
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.variants_spawned, 3);
  // First event = the video clone via the full-generate orchestrator; rest = the static maker.
  assert.equal(sentInngest[0].name, "ad-tool/generate-full");
  assert.equal(sentInngest[1].name, "ad-tool/static-requested");
  assert.equal((sentInngest[1].data as { archetype: string }).archetype, "before_after");
  assert.equal(sentInngest[2].name, "ad-tool/static-requested");
  // The video row carries the cloned script + hero; the statics start clean.
  const videoRow = stores.inserted_ad_campaigns[0] as Record<string, unknown>;
  assert.equal(videoRow.script_text, "you tried everything…");
  assert.equal(videoRow.hero_image_url, "https://cdn.example/hero.png");
  assert.equal(videoRow.length_sec, 30);
  assert.equal(videoRow.scene_style, "kitchen_counter");
  const staticRow = stores.inserted_ad_campaigns[1] as Record<string, unknown>;
  assert.equal(staticRow.script_text, null);
  assert.equal(staticRow.hero_image_url, null);
});

test("amplifyWinner respects MAX_AMPLIFICATIONS_PER_DAY — two cap-sized calls in one day never exceed the daily ceiling", async () => {
  // Pretend a prior call today already spawned MAX_VARIANTS_PER_WINNER campaigns.
  const stores: AmplifyFakeStores = {
    director_activity_today: [
      { metadata: { new_ad_campaign_ids: ["camp-prev-1", "camp-prev-2", "camp-prev-3", "camp-prev-4"] } },
    ],
    inserted_ad_campaigns: [],
  };
  const { admin } = makeAmplifyAdmin(stores);
  const { deps } = makeAmplifySpyDeps();

  // Second call (still under the day cap) — budget = 8 - 4 = 4, n=4 → spawns 4.
  const res1 = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner: makeFixtureWinner({ metaAdId: "AD-WIN-B" }),
    n: MAX_VARIANTS_PER_WINNER,
    nowMs: Date.parse("2026-06-30T12:00:00Z"),
    deps,
  });
  assert.equal(res1.ok, true);
  assert.equal(res1.day_count_before, 4);
  assert.equal(res1.variants_spawned, MAX_VARIANTS_PER_WINNER);
  // The fake's director_activity_today won't reflect the new row (the spy captures it instead);
  // simulate that explicitly so the next call sees the realistic post-state.
  stores.director_activity_today.push({ metadata: { new_ad_campaign_ids: res1.new_ad_campaign_ids } });

  // Third call — budget now 0, returns daily_cap_reached with zero inserts.
  const res2 = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner: makeFixtureWinner({ metaAdId: "AD-WIN-C" }),
    n: MAX_VARIANTS_PER_WINNER,
    nowMs: Date.parse("2026-06-30T18:00:00Z"),
    deps,
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "daily_cap_reached");
  assert.equal(res2.variants_spawned, 0);
  assert.equal(res2.new_ad_campaign_ids.length, 0);
  // Total ad_campaigns inserts ≤ MAX_AMPLIFICATIONS_PER_DAY total across the two real calls.
  assert.ok(stores.inserted_ad_campaigns.length <= MAX_AMPLIFICATIONS_PER_DAY);
});

test("amplifyWinner refuses to amplify when the source campaign join is missing", async () => {
  const stores: AmplifyFakeStores = { director_activity_today: [], inserted_ad_campaigns: [] };
  const { admin } = makeAmplifyAdmin(stores);
  const { deps, sentInngest, recordedActivity } = makeAmplifySpyDeps();
  const winner = makeFixtureWinner({ campaign: null });
  const res = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner,
    n: 4,
    nowMs: Date.parse("2026-06-30T12:00:00Z"),
    deps,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_source_campaign");
  assert.equal(sentInngest.length, 0);
  assert.equal(recordedActivity.length, 0);
  assert.equal(stores.inserted_ad_campaigns.length, 0);
});

test("topK trims to the requested cap, keeping the highest-ROAS rows", async () => {
  // Three above-floor winners; topK=2 keeps the top two by ROAS.
  const rows: WinnerAttributionRow[] = [
    { meta_ad_id: "AD-A", variant: "advertorial", ad_campaign_id: "C-A", angle_id: "ANG-A", sessions: 800, attributed_spend_cents: 20_000, revenue_cents: 200_000, snapshot_date: "2026-06-25" }, // ROAS 10
    { meta_ad_id: "AD-B", variant: "beforeafter", ad_campaign_id: "C-B", angle_id: "ANG-B", sessions: 400, attributed_spend_cents: 10_000, revenue_cents: 80_000, snapshot_date: "2026-06-25" }, // ROAS 8
    { meta_ad_id: "AD-C", variant: "reasons", ad_campaign_id: "C-C", angle_id: "ANG-C", sessions: 200, attributed_spend_cents: 10_000, revenue_cents: 50_000, snapshot_date: "2026-06-25" }, // ROAS 5
  ];
  const stores: FakeStores = {
    meta_attribution_daily: rows.map((r) => ({ ...r, workspace_id: "ws-1" })),
    ad_campaigns: ["C-A", "C-B", "C-C"].map((id) => ({ id, workspace_id: "ws-1", name: id, product_id: null, variant_id: null, avatar_id: null, angle_id: null, script_text: null, hero_image_url: null, landing_url: null, composition: null, length_sec: 15, scene_style: null, caption_style: null })),
    product_ad_angles: ["ANG-A", "ANG-B", "ANG-C"].map((id) => ({ id, workspace_id: "ws-1", hook_slug: "x", lf8_slot: 1, lead_benefit_anchor: "x", hook_one_liner: null, meta_headline: null, meta_primary_text: null, meta_description: null })),
  };
  const winners = await detectWinners(makeAdmin(stores), {
    workspaceId: "ws-1",
    topK: 2,
    nowMs: Date.parse("2026-06-30T00:00:00Z"),
  });
  assert.equal(winners.length, 2);
  assert.deepEqual(
    winners.map((w) => w.metaAdId),
    ["AD-A", "AD-B"],
  );
});

// ── Phase 3 — Matched-lander experiment (forward direction) ──────────────────────

test("landerTypeForAmplifiedWinner maps advertorial-family variants → lander_type and skips PDP", () => {
  assert.equal(landerTypeForAmplifiedWinner("advertorial"), "advertorial");
  assert.equal(landerTypeForAmplifiedWinner("beforeafter"), "beforeafter");
  assert.equal(landerTypeForAmplifiedWinner("before-after"), "beforeafter");
  assert.equal(landerTypeForAmplifiedWinner("before_after"), "beforeafter");
  assert.equal(landerTypeForAmplifiedWinner("listicle"), "listicle");
  assert.equal(landerTypeForAmplifiedWinner("reasons"), "listicle");
  // Non-advertorial-family variants skip the matched-lander pair.
  assert.equal(landerTypeForAmplifiedWinner("pdp"), null);
  assert.equal(landerTypeForAmplifiedWinner("testimonial"), null);
  assert.equal(landerTypeForAmplifiedWinner(""), null);
});

test("patchFromWinnerAngle packs the winner's hook/mechanism into a reversible VariantPatch", () => {
  const patch = patchFromWinnerAngle({
    id: "ANG-A",
    hook_slug: "problem_now",
    lf8_slot: 1,
    lead_benefit_anchor: "sleep deeper",
    hook_one_liner: "still tired at 3pm?",
    meta_headline: "Sleep deeper in 2 weeks",
    meta_primary_text: "The breakdown 12,000 women trust",
    meta_description: null,
  });
  assert.equal(patch.headline, "Sleep deeper in 2 weeks");
  assert.equal(patch.dek, "The breakdown 12,000 women trust");
  assert.equal(patch.chapterHeading, "still tired at 3pm?");
});

test("patchFromWinnerAngle falls back to hook_one_liner when meta_headline is missing", () => {
  const patch = patchFromWinnerAngle({
    id: "ANG-B",
    hook_slug: "results_first",
    lf8_slot: 2,
    lead_benefit_anchor: "less bloating",
    hook_one_liner: "flatter in a week",
    meta_headline: null,
    meta_primary_text: null,
    meta_description: null,
  });
  assert.equal(patch.headline, "flatter in a week");
  assert.equal(patch.dek, undefined);
  // headline and chapterHeading are the same string → chapterHeading is omitted to avoid a no-op patch.
  assert.equal(patch.chapterHeading, undefined);
});

test("patchFromWinnerAngle returns {} for a null angle", () => {
  assert.deepEqual(patchFromWinnerAngle(null), {});
});

function makePairFixtureWinner(over: Partial<DetectedWinner> = {}): DetectedWinner {
  return {
    workspaceId: "ws-1",
    metaAdId: "AD-WIN-A",
    variant: "advertorial",
    spendCents: 20_000,
    onsiteCents: 100_000,
    haloAdjustedRevenueCents: 100_000,
    roas: 5,
    sessions: 800,
    windowStart: "2026-06-16",
    windowEnd: "2026-06-30",
    campaign: {
      id: "C-A",
      name: "winning advertorial",
      product_id: "P-1",
      variant_id: "V-1",
      avatar_id: "AV-1",
      angle_id: "ANG-A",
      script_text: null,
      hero_image_url: null,
      landing_url: "https://shop.example.com/x",
      composition: null,
      length_sec: 15,
      scene_style: "outdoor_selfie",
      caption_style: "hormozi_yellow",
    },
    angle: {
      id: "ANG-A",
      hook_slug: "problem_now",
      lf8_slot: 1,
      lead_benefit_anchor: "sleep deeper",
      hook_one_liner: "still tired at 3pm?",
      meta_headline: "Sleep deeper in 2 weeks",
      meta_primary_text: "The breakdown 12,000 women trust",
      meta_description: null,
    },
    ...over,
  };
}

test("pairAmplifiedWinnerWithLander opens a status='draft' storefront experiment + stamps paired_winner_lander", async () => {
  const materializeCalls: Array<Record<string, unknown>> = [];
  const recordedActivity: Array<Record<string, unknown>> = [];
  const deps: AmplifyWinnerDeps = {
    sendInngest: async () => undefined,
    recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    materializeOptimizerCampaign: async (o) => {
      materializeCalls.push(o as unknown as Record<string, unknown>);
      return { ok: true, experiment_id: "exp-paired-1", lever_key: "winner_lander_match", detail: "stood up (draft)" };
    },
  };

  const res = await pairAmplifiedWinnerWithLander({} as never, {
    workspaceId: "ws-1",
    winner: makePairFixtureWinner(),
    newAdCampaignIds: ["camp-1", "camp-2"],
    specSlug: "growth-winning-creative-amplifier",
    deps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.experiment_id, "exp-paired-1");
  assert.equal(res.lander_type, "advertorial");
  // The materialize call must request status='draft' (owner-approved before serving).
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0].initialStatus, "draft");
  assert.equal(materializeCalls[0].productId, "P-1");
  const proposal = materializeCalls[0].proposal as Record<string, unknown>;
  assert.equal(proposal.lander_type, "advertorial");
  assert.equal(proposal.lever_class, "reversible");
  const variant = proposal.variant as Record<string, unknown>;
  const patch = variant.patch as Record<string, string>;
  assert.equal(patch.headline, "Sleep deeper in 2 weeks");
  assert.equal(patch.dek, "The breakdown 12,000 women trust");
  // ONE paired_winner_lander director_activity row stamped.
  assert.equal(recordedActivity.length, 1);
  const row = recordedActivity[0] as { actionKind: string; metadata: Record<string, unknown> };
  assert.equal(row.actionKind, PAIRED_WINNER_LANDER_ACTION_KIND);
  assert.equal(row.metadata.direction, "ad_to_lander");
  assert.equal(row.metadata.source_meta_ad_id, "AD-WIN-A");
  assert.equal(row.metadata.lander_type, "advertorial");
  assert.equal(row.metadata.experiment_id, "exp-paired-1");
  assert.deepEqual(row.metadata.new_ad_campaign_ids, ["camp-1", "camp-2"]);
});

test("pairAmplifiedWinnerWithLander maps before-after winner to lander_type='beforeafter'", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const deps: AmplifyWinnerDeps = {
    sendInngest: async () => undefined,
    recordActivity: async () => undefined,
    materializeOptimizerCampaign: async (o) => {
      calls.push(o as unknown as Record<string, unknown>);
      return { ok: true, experiment_id: "exp-ba", lever_key: "winner_lander_match", detail: "ok" };
    },
  };
  const res = await pairAmplifiedWinnerWithLander({} as never, {
    workspaceId: "ws-1",
    winner: makePairFixtureWinner({ variant: "beforeafter" }),
    newAdCampaignIds: [],
    deps,
  });
  assert.equal(res.ok, true);
  assert.equal(res.lander_type, "beforeafter");
  const proposal = calls[0].proposal as Record<string, unknown>;
  assert.equal(proposal.lander_type, "beforeafter");
});

test("pairAmplifiedWinnerWithLander skips a PDP / non-advertorial-family variant", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const recordedActivity: Array<Record<string, unknown>> = [];
  const deps: AmplifyWinnerDeps = {
    sendInngest: async () => undefined,
    recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    materializeOptimizerCampaign: async (o) => {
      calls.push(o as unknown as Record<string, unknown>);
      return { ok: true, experiment_id: "exp-x", lever_key: "winner_lander_match", detail: "ok" };
    },
  };
  const res = await pairAmplifiedWinnerWithLander({} as never, {
    workspaceId: "ws-1",
    winner: makePairFixtureWinner({ variant: "pdp" }),
    newAdCampaignIds: [],
    deps,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "variant_not_advertorial_family");
  // No materialize, no activity row.
  assert.equal(calls.length, 0);
  assert.equal(recordedActivity.length, 0);
});

test("pairAmplifiedWinnerWithLander reports the optimizer's refusal (e.g. surface already has an active campaign)", async () => {
  const recordedActivity: Array<Record<string, unknown>> = [];
  const deps: AmplifyWinnerDeps = {
    sendInngest: async () => undefined,
    recordActivity: async (_admin, row) => { recordedActivity.push(row as unknown as Record<string, unknown>); return undefined; },
    materializeOptimizerCampaign: async () =>
      ({ ok: false, detail: "a campaign is already active on P-1:advertorial:all — not standing up a second" }),
  };
  const res = await pairAmplifiedWinnerWithLander({} as never, {
    workspaceId: "ws-1",
    winner: makePairFixtureWinner(),
    newAdCampaignIds: ["camp-1"],
    deps,
  });
  assert.equal(res.ok, false);
  assert.ok(res.reason?.startsWith("materialize_refused:"));
  // No paired_winner_lander row when the materialize refused.
  assert.equal(recordedActivity.length, 0);
});

test("amplifyWinner end-to-end opens the matched-lander draft experiment for an advertorial winner", async () => {
  const stores: AmplifyFakeStores = { director_activity_today: [], inserted_ad_campaigns: [] };
  const { admin } = makeAmplifyAdmin(stores);
  const { deps, recordedActivity } = makeAmplifySpyDeps();
  // Wire the materialize spy alongside the existing inngest+activity spies.
  const materializeCalls: Array<Record<string, unknown>> = [];
  const fullDeps: AmplifyWinnerDeps = {
    ...deps,
    materializeOptimizerCampaign: async (o) => {
      materializeCalls.push(o as unknown as Record<string, unknown>);
      return { ok: true, experiment_id: "exp-end-to-end", lever_key: "winner_lander_match", detail: "ok" };
    },
  };

  const res = await amplifyWinner(admin, {
    workspaceId: "ws-1",
    winner: makePairFixtureWinner(),
    n: 2,
    specSlug: "growth-winning-creative-amplifier",
    nowMs: Date.parse("2026-06-30T12:00:00Z"),
    deps: fullDeps,
  });

  assert.equal(res.ok, true);
  assert.equal(res.variants_spawned, 2);
  // ONE matched-lander draft experiment was opened on the advertorial surface.
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0].initialStatus, "draft");
  // Activity stamps: amplified_winner + paired_winner_lander (one of each).
  const kinds = recordedActivity.map((r) => (r as { actionKind: string }).actionKind);
  assert.ok(kinds.includes(AMPLIFIED_WINNER_ACTION_KIND));
  assert.ok(kinds.includes(PAIRED_WINNER_LANDER_ACTION_KIND));
  // The pair result is surfaced on the AmplifyWinnerResult so the caller can inspect it.
  assert.equal(res.pair?.ok, true);
  assert.equal(res.pair?.experiment_id, "exp-end-to-end");
});

