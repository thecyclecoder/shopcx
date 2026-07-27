/**
 * creative-skeleton — retryable AdLibrary creative-fetch skip
 * ([[../../docs/brain/specs/do-not-permanently-fail-creative-scout-ads-on-retryable-adlibrary-fetch-errors]]).
 *
 * A single AdLibrary 503 during a sweep must NOT permanently poison a promising competitor ad by
 * writing a `creative_skeletons.status='failed'` row — its `dedup_key` would then be filtered by
 * `splitNewExisting` on every future sweep, so the same ad could never be retried. The fix lives
 * across two touch points:
 *   • `src/lib/adlibrary.ts` — `isRetryableCreativeFetchError` classifies transient statuses.
 *   • `src/lib/creative-skeleton.ts` — `ingestAd` rethrows before any DB write; `collectAndTrack`
 *     downgrades the log to a bounded warning and still counts the ad as an attempted failure.
 *
 * This test drives `sweepCompetitorLanes` with a stubbed `fetchCreative` that throws
 * `adlibrary_creative_503`, an admin stub whose upsert asserts nothing gets persisted, and a
 * `console.error` spy that asserts the Vercel error-feed path is NOT taken.
 *
 * Run:
 *   npx tsx --test src/lib/creative-skeleton.retryable-fetch.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

import {
  isRetryableCreativeFetchError,
  RETRYABLE_CREATIVE_FETCH_STATUSES,
} from "./adlibrary";

// ── Direct helper tests ──────────────────────────────────────────

test("isRetryableCreativeFetchError: transient AdLibrary statuses are retryable", () => {
  for (const status of RETRYABLE_CREATIVE_FETCH_STATUSES) {
    assert.equal(
      isRetryableCreativeFetchError(new Error(`adlibrary_creative_${status}`)),
      true,
      `status ${status} should be retryable`,
    );
  }
});

test("isRetryableCreativeFetchError: terminal AdLibrary statuses are NOT retryable", () => {
  for (const status of [400, 401, 403, 404, 410, 422]) {
    assert.equal(
      isRetryableCreativeFetchError(new Error(`adlibrary_creative_${status}`)),
      false,
      `status ${status} must be terminal (permanent failed row is correct)`,
    );
  }
});

test("isRetryableCreativeFetchError: unrelated errors are NOT retryable", () => {
  assert.equal(isRetryableCreativeFetchError(new Error("vision_500")), false);
  assert.equal(isRetryableCreativeFetchError(new Error("boom")), false);
  assert.equal(isRetryableCreativeFetchError(null), false);
  assert.equal(isRetryableCreativeFetchError(undefined), false);
  assert.equal(isRetryableCreativeFetchError("adlibrary_creative_503"), false); // string, not Error
});

test("isRetryableCreativeFetchError: fetch network hiccups are retryable", () => {
  assert.equal(isRetryableCreativeFetchError(new TypeError("fetch failed")), true);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isRetryableCreativeFetchError(abort), true);
});

// ── Integration: sweep with a stubbed retryable fetch ─────────────

interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
}

const upserts: UpsertCall[] = [];
const errorLogs: unknown[][] = [];
const warnLogs: unknown[][] = [];
let fetchCreativeCalls = 0;

function resetSpies(): void {
  upserts.length = 0;
  errorLogs.length = 0;
  warnLogs.length = 0;
  fetchCreativeCalls = 0;
}

const origError = console.error;
const origWarn = console.warn;
console.error = (...args: unknown[]) => {
  errorLogs.push(args);
};
console.warn = (...args: unknown[]) => {
  warnLogs.push(args);
};

interface AdminBuilder {
  select(cols: string): AdminBuilder;
  eq(col: string, val: unknown): AdminBuilder;
  in(col: string, vals: unknown[]): AdminBuilder;
  update(_patch: Record<string, unknown>): AdminBuilder;
  upsert(row: Record<string, unknown>, opts?: unknown): Promise<{ data: null; error: null }>;
  single(): Promise<{ data: unknown; error: null }>;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then?: (resolve: (v: { data: unknown[]; error: null }) => void) => void;
}

// A stub admin whose splitNewExisting read returns NO existing keys — so `sweepCompetitorLanes`
// routes every pulled ad through `ingestAd` (which is exactly where our fix lives).
function makeBuilder(table: string): AdminBuilder {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  let selectedCols = "";
  const builder: AdminBuilder = {
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
    async upsert(row: Record<string, unknown>, _opts?: unknown) {
      upserts.push({ table, row });
      return { data: null, error: null };
    },
    async single() {
      return { data: null, error: null };
    },
    async maybeSingle() {
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      // splitNewExisting: no existing keys → every ad is FRESH → routed through ingestAd.
      if (
        table === "creative_skeletons" &&
        selectedCols === "dedup_key" &&
        Array.isArray(inFilters.dedup_key)
      ) {
        resolve({ data: [], error: null });
        return;
      }
      // markDisappearedAds: nothing active to retire.
      if (
        table === "creative_skeletons" &&
        selectedCols === "id, dedup_key" &&
        filters.still_active === true
      ) {
        resolve({ data: [], error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  };
  return builder;
}

const stubAdmin = {
  from(table: string) {
    return makeBuilder(table);
  },
  storage: {
    getBucket: async () => ({ data: { name: "creative-shots" }, error: null }),
    createBucket: async () => ({ data: null, error: null }),
    from: (_bucket: string) => ({
      upload: async () => ({ data: null, error: null }),
    }),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };

moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realAdlibrary = require("@/lib/adlibrary") as typeof import("./adlibrary");

moduleAny._cache[require.resolve("@/lib/adlibrary")] = {
  exports: {
    ...realAdlibrary,
    // A single static ad is returned; `sweepCompetitorLanes`'s LANE-A winners scan will be empty
    // (see stub below) so the keyword fallback path fires and drives it into `collectAndTrack`.
    searchAds: async (_params: Record<string, unknown>) => [
      {
        ad_key: "flake-503",
        advertiser: "NativePath",
        title: null,
        body: null,
        message: null,
        call_to_action: null,
        destination_domain: null,
        landing_page_url: null,
        ad_snapshot_url: null,
        page_id: null,
        has_store_url: null,
        preview_img_url: "https://cdn/flake.jpg",
        resource_urls: [],
        video_duration: null,
        ads_type: 1,
        platform: null,
        fb_merge_channel: null,
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
        raw: {},
        media_type: "static" as const,
        creative_url: "https://cdn/flake.jpg",
      },
    ],
    fetchCreative: async (_url: string) => {
      fetchCreativeCalls++;
      // The failing state: a single transient 503. Before the fix this would land as a
      // permanent `creative_skeletons.status='failed'` row.
      throw new Error("adlibrary_creative_503");
    },
  },
};

moduleAny._cache[require.resolve("@/lib/adlibrary-winners")] = {
  exports: {
    resolveAdvertiser: async (name: string, _opts?: { domain?: string | null }) => ({
      via: "name" as const,
      pageId: "page-nativepath",
      name,
    }),
    // Winners scan empty → forces the keyword fallback path, which is the branch that reaches
    // `collectAndTrack` → `ingestAd` (where the fix lives).
    scanWinners: async () => [],
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sweepCompetitorLanes } = require("@/lib/creative-skeleton") as typeof import("./creative-skeleton");

test("retryable 503: no failed skeleton row persisted, counted as per-ad failure, no error log", async () => {
  resetSpies();

  const r = await sweepCompetitorLanes(
    "ws-1",
    {
      keyword: "NativePath",
      kind: "competitor",
      competitorId: "cid-nativepath",
      productId: "creamer",
      expectedDomain: "nativepath.com",
      expectedAdvertiser: "NativePath",
    },
    { domain: "nativepath.com", approvedAdvertisers: new Set(["nativepath"]) },
  );

  // Sweep counters: attempted + failed once, inserted zero — the ad IS counted, just not persisted.
  assert.equal(r.inserted, 0, "no ad ingested (fetch flaked)");
  assert.equal(r.failed, 1, "the ad is still counted as an attempted per-ad failure");
  assert.equal(r.longRunners, 1, "one fresh ad was in the sweep");

  // The invariant: NO `creative_skeletons` upsert (row would poison future sweeps via dedup_key).
  const skeletonUpserts = upserts.filter((u) => u.table === "creative_skeletons");
  assert.equal(
    skeletonUpserts.length,
    0,
    `no creative_skeletons row should be written on a transient fetch failure, got ${skeletonUpserts.length}`,
  );

  // The log invariant: NO `console.error` from the retryable branch (it was a warn, not an
  // incident). We accept unrelated errors (e.g. from other paths) but the retryable ingest itself
  // must not log to error.
  const ingestErrs = errorLogs.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("[creative-scout] ingest failed")),
  );
  assert.equal(ingestErrs.length, 0, "retryable fetch must not go to console.error");
  const fetchErrs = errorLogs.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("[creative-finder] creative fetch failed")),
  );
  assert.equal(fetchErrs.length, 0, "retryable fetch must not go to the terminal-fetch error log");

  // And the retryable branch WAS taken (bounded warning).
  const skipWarns = warnLogs.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("retryable AdLibrary creative fetch skipped")),
  );
  assert.equal(skipWarns.length, 1, "one bounded warning per retryable fetch skip");

  assert.equal(fetchCreativeCalls, 1, "fetchCreative was attempted once for the ad");
});

test.after(() => {
  console.error = origError;
  console.warn = origWarn;
});
