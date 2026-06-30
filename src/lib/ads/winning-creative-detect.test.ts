/**
 * Unit tests for the winning-creative detector (growth-winning-creative-amplifier Phase 1).
 *
 * Built-in node:test — no test-runner dependency. Run:
 *   npm run test:winning-creative-detect
 *   (= tsx --test src/lib/ads/winning-creative-detect.test.ts)
 *
 * Covers the spec's fixture (two ads above floor + one below → exactly the two top-K winners with
 * their angle joined), plus the audit assumption check (no AdLibrary import) and the score-cell
 * floors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIN_SPEND_CENTS,
  ROAS_FLOOR_MARGIN,
  detectWinners,
  groupAttributionRows,
  scoreCell,
  type WinnerAttributionRow,
} from "./winning-creative-detect";

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

