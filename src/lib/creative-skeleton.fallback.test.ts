/**
 * sweepCompetitorLanes — LANE-A winners-empty fallback (spec 2026-07-19).
 *
 * The direct-API probes on Amazing Creamer show:
 *   • NativePath winners API returns 0, keyword/domain search returns 60 static ads
 *   • Vital Proteins winners API returns 0, keyword/domain search returns 46 static ads
 *   • Obvi winners returns 3 (of which 1 ingests)
 *
 * Before this phase, `scanWinners` empty → `transientEmptyPull=true` and the competitor
 * ingested NOTHING. That starved the skeleton library for exactly the brands that
 * advertise the most. This phase pins:
 *
 *   1. LANE A `scanWinners` empty → the keyword `searchAds` fallback fires and
 *      `source='keyword'` records which path fed the ingest.
 *   2. LANE A winners populated → NO fallback searchAds call (winners is preferred).
 *   3. LANE A winners + keyword both empty → the domain fallback fires and
 *      `source='domain'` records the path.
 *   4. All three empty → `transientEmptyPull=true`, `source=null`, no retire.
 *
 * We stub the AdLibrary + adlibrary-winners + Supabase admin modules through Node's
 * ESM module cache BEFORE dynamic-importing `./creative-skeleton`. The stub admin
 * routes every searched ad through `reobserveAd` (existing) so no `ingestAd`/vision
 * HTTP fires — the invariant we care about is the SOURCE-SELECTION branch, not the
 * per-ad ingest which is exercised by the winners lane's existing shape.
 *
 * Run:
 *   npx tsx --test src/lib/creative-skeleton.fallback.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// ── World state ───────────────────────────────────────────────────

interface Call {
  kind: "resolveAdvertiser" | "scanWinners" | "searchAds";
  args: unknown;
}

const calls: Call[] = [];

let winnersResult: Array<{ ad: Record<string, unknown>; composite: number | null }> = [];
let keywordAds: Array<{ ad_key: string; advertiser: string | null }> = [];
let domainAds: Array<{ ad_key: string; advertiser: string | null }> = [];

function resetWorld(): void {
  calls.length = 0;
  winnersResult = [];
  keywordAds = [];
  domainAds = [];
}

// ── Supabase admin stub ────────────────────────────────────────────
// Only the reads/writes `sweepCompetitorLanes` actually issues via
// `splitNewExisting`, `reobserveAd`, and `markDisappearedAds`:
//   • splitNewExisting → returns EVERY searched dedup_key as existing → all ads route
//     through reobserveAd (avoids the ingestAd/vision path).
//   • reobserveAd → maybeSingle returns a plausible existing row; update no-ops.
//   • markDisappearedAds → returns [] (nothing to retire).

interface AdminBuilder {
  select(cols: string): AdminBuilder;
  eq(col: string, val: unknown): AdminBuilder;
  in(col: string, vals: unknown[]): AdminBuilder;
  update(_patch: Record<string, unknown>): AdminBuilder;
  upsert(_row: Record<string, unknown>, _opts?: unknown): Promise<{ data: null; error: null }>;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  single(): Promise<{ data: unknown; error: null }>;
  then?: undefined;
}

function makeBuilder(table: string): AdminBuilder & PromiseLike<{ data: unknown[]; error: null }> {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  let selectedCols = "";
  const builder = {
    select(cols: string) {
      selectedCols = cols;
      return builder;
    },
    eq(col: string, val: unknown) {
      filters[col] = val;
      return builder;
    },
    in(col: string, vals: unknown[]) {
      inFilters[col] = vals;
      return builder;
    },
    update(_patch: Record<string, unknown>) {
      return builder;
    },
    async upsert(_row: Record<string, unknown>) {
      return { data: null, error: null };
    },
    async maybeSingle() {
      if (table === "creative_skeletons" && selectedCols.includes("our_first_seen")) {
        return {
          data: {
            id: `existing-${filters.dedup_key}`,
            our_first_seen: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
            observed_sweeps: 5,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    async single() {
      // reobserveAd's read shape: select("id, our_first_seen, observed_sweeps") + eq filters.
      if (table === "creative_skeletons" && selectedCols.includes("our_first_seen")) {
        return {
          data: {
            id: `existing-${filters.dedup_key}`,
            our_first_seen: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
            observed_sweeps: 5,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    // Awaiting the builder directly is the pattern used by splitNewExisting/markDisappearedAds.
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      if (
        table === "creative_skeletons" &&
        selectedCols === "dedup_key" &&
        Array.isArray(inFilters.dedup_key)
      ) {
        // splitNewExisting — every queried key is "existing" → all route through reobserveAd.
        resolve({
          data: (inFilters.dedup_key as string[]).map((k) => ({ dedup_key: k })),
          error: null,
        });
        return;
      }
      if (
        table === "creative_skeletons" &&
        selectedCols === "id, dedup_key" &&
        filters.still_active === true
      ) {
        // markDisappearedAds — nothing active to retire.
        resolve({ data: [], error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  } as unknown as AdminBuilder & PromiseLike<{ data: unknown[]; error: null }>;
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeBuilder(table);
  },
};

// ── Wire the stubs BEFORE importing creative-skeleton ─────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };

moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};

// Preserve normalizeAd + winnerScore (used inside sweepCompetitorLanes) — only stub searchAds
// + fetchCreative. `normalizeAd` and `winnerScore` are pure, we keep the real ones.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realAdlibrary = require("@/lib/adlibrary") as typeof import("./adlibrary");

moduleAny._cache[require.resolve("@/lib/adlibrary")] = {
  exports: {
    ...realAdlibrary,
    searchAds: async (params: Record<string, unknown>) => {
      calls.push({ kind: "searchAds", args: params });
      const source = params.keyword ? keywordAds : domainAds;
      // Return the ads as normalized-shape rows the sweep expects: media_type='static' +
      // a creative_url so the filter passes. Advertiser flows through the approved-advertiser
      // guard unchanged.
      return source.map((a) => ({
        ...a,
        media_type: "static" as const,
        creative_url: `https://cdn/${a.ad_key}.jpg`,
        title: null,
        destination_domain: null,
        landing_page_url: null,
        has_store_url: null,
        call_to_action: null,
        body: null,
        message: null,
        estimated_spend: null,
        all_exposure_value: null,
        impression: null,
        heat: null,
        like_count: null,
        comment_count: null,
        share_count: null,
        view_count: null,
        first_seen: null,
        last_seen: null,
        days_count: null,
        resume_advertising_flag: null,
        platform: null,
        fb_merge_channel: null,
        ads_type: null,
        raw: {},
      }));
    },
    fetchCreative: async () => {
      throw new Error("stub — not called in this test (all ads route as existing)");
    },
  },
};

moduleAny._cache[require.resolve("@/lib/adlibrary-winners")] = {
  exports: {
    resolveAdvertiser: async (name: string, opts?: { domain?: string | null }) => {
      calls.push({ kind: "resolveAdvertiser", args: { name, domain: opts?.domain } });
      // Every test targets LANE A (via:'name') so the fallback path is exercised. Tests
      // that need bad-seed / LANE B behavior can adjust the world above.
      return { via: "name" as const, pageId: "page-123", name };
    },
    scanWinners: async (pageId: string) => {
      calls.push({ kind: "scanWinners", args: pageId });
      return winnersResult;
    },
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sweepCompetitorLanes } = require("@/lib/creative-skeleton") as typeof import("./creative-skeleton");

// ── Tests ─────────────────────────────────────────────────────────

const seed = {
  keyword: "NativePath",
  kind: "competitor" as const,
  competitorId: "cid-nativepath",
  productId: "creamer",
  expectedDomain: "nativepath.com",
  expectedAdvertiser: "NativePath",
};

test("winners populated → source='winners', no fallback searchAds call", async () => {
  resetWorld();
  winnersResult = [
    {
      ad: { ad_key: "obvi1", advertiser: "Obvi", ads_type: 1, preview_img_url: "https://cdn/o1.jpg" },
      composite: 100,
    },
  ];
  // If the fallback fires this will pollute the search
  keywordAds = [{ ad_key: "should-not-be-pulled", advertiser: "Obvi" }];

  const r = await sweepCompetitorLanes("ws-1", { ...seed, keyword: "Obvi" }, {
    domain: "obvi.com",
    approvedAdvertisers: new Set(["obvi"]),
  });

  assert.equal(r.lane, "winners");
  assert.equal(r.source, "winners");
  assert.equal(r.searched, 1);
  assert.equal(r.transientEmptyPull, false);
  // The keyword fallback MUST NOT have fired — winners was populated
  assert.equal(calls.some((c) => c.kind === "searchAds"), false);
});

test("winners empty + keyword returns ads → source='keyword' (Obvi/NativePath/Vital fingerprint)", async () => {
  resetWorld();
  winnersResult = []; // the failing state — winners API returns 0
  keywordAds = [
    { ad_key: "np-a1", advertiser: "NativePath" },
    { ad_key: "np-a2", advertiser: "NativePath" },
    { ad_key: "np-a3", advertiser: "NativePath" },
  ];

  const r = await sweepCompetitorLanes("ws-1", seed, {
    domain: "nativepath.com",
    approvedAdvertisers: new Set(["nativepath"]),
  });

  assert.equal(r.lane, "winners", "resolution stays winners — that's how the competitor routed");
  assert.equal(r.source, "keyword", "but the ingest source is keyword — the fallback fired");
  assert.equal(r.searched, 3);
  assert.equal(r.transientEmptyPull, false);
  assert.equal(r.nonMappedDropped, 0);
  // The keyword searchAds was called with the seed keyword; the domain fallback was NOT
  // (keyword found ads so the second-level fallback short-circuits).
  const searches = calls.filter((c) => c.kind === "searchAds") as Array<{ args: Record<string, unknown> }>;
  assert.equal(searches.length, 1);
  assert.equal(searches[0].args.keyword, "NativePath");
  assert.deepEqual(searches[0].args.adsType, ["1"]);
  assert.deepEqual(searches[0].args.platform, ["facebook", "instagram"]);
  assert.deepEqual(searches[0].args.geo, ["USA"]);
});

test("winners empty + keyword empty + domain returns ads → source='domain'", async () => {
  resetWorld();
  winnersResult = [];
  keywordAds = [];
  domainAds = [
    { ad_key: "vp-a1", advertiser: "Vital Proteins" },
    { ad_key: "vp-a2", advertiser: "Vital Proteins LLC" },
  ];

  const r = await sweepCompetitorLanes("ws-1", { ...seed, keyword: "Vital Proteins" }, {
    domain: "vitalproteins.com",
    approvedAdvertisers: new Set(["vitalproteins", "vitalproteinsllc"]),
  });

  assert.equal(r.lane, "winners");
  assert.equal(r.source, "domain", "domain fallback fed the ingest");
  assert.equal(r.searched, 2);
  assert.equal(r.transientEmptyPull, false);
  // BOTH fallbacks were tried in order — keyword first, then domain.
  const searches = calls.filter((c) => c.kind === "searchAds") as Array<{ args: Record<string, unknown> }>;
  assert.equal(searches.length, 2);
  assert.equal(searches[0].args.keyword, "Vital Proteins");
  assert.equal(searches[1].args.domain, "vitalproteins.com");
});

test("winners empty + keyword empty + no domain → transientEmptyPull, source=null, no retire", async () => {
  resetWorld();
  winnersResult = [];
  keywordAds = [];
  // no domainAds — but ALSO no domain opt so the domain fallback is skipped entirely
  const r = await sweepCompetitorLanes("ws-1", seed, {
    approvedAdvertisers: new Set(["nativepath"]),
  });
  assert.equal(r.lane, "winners");
  assert.equal(r.source, null);
  assert.equal(r.transientEmptyPull, true);
  assert.equal(r.retired, 0, "MUST NOT retire on empty pull");
  // Domain fallback NOT attempted (no opts.domain)
  const searches = calls.filter((c) => c.kind === "searchAds");
  assert.equal(searches.length, 1, "only the keyword fallback was tried");
});

test("winners empty + fallback yields ads WITH non-mapped advertisers → guard still drops them", async () => {
  resetWorld();
  winnersResult = [];
  keywordAds = [
    { ad_key: "np-real", advertiser: "NativePath" },
    { ad_key: "leak-1", advertiser: "Healthy Habits" }, // the Creamer leakage fingerprint
    { ad_key: "leak-2", advertiser: "A Path to Better Health" },
  ];

  const r = await sweepCompetitorLanes("ws-1", seed, {
    domain: "nativepath.com",
    approvedAdvertisers: new Set(["nativepath"]),
  });

  assert.equal(r.source, "keyword");
  assert.equal(r.searched, 3, "raw pull count is 3");
  assert.equal(r.nonMappedDropped, 2, "the two non-mapped advertisers are dropped at the persist boundary");
});
