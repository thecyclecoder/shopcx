/**
 * angle-demand-sweep tests — pin the Phase-1 provider SDK's contract:
 *   (i)   known-high volume in product_seo_keywords → tier:'high' + source:'product_seo_keywords'
 *   (ii)  unknown ingredient (no matching rows) → the provider hook fires (default: stub)
 *   (iii) sensitive column names cannot be smuggled via the arg surface (defense-in-depth) —
 *         the SDK's select column list is fixed regardless of caller input.
 *
 * Also covers the tier boundaries + tokenizer + provider swap so a future paid-source spec has
 * a green baseline to build on. Pure unit tests — no supabase pooler, no network.
 *
 * Run: npx tsx --test src/lib/ads/angle-demand-sweep.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSearchDemand,
  tierForVolume,
  problemTokens,
  setSearchDemandProvider,
  resetSearchDemandProvider,
  HIGH_MIN_VOLUME,
  MEDIUM_MIN_VOLUME,
  stubProvider,
  type SearchDemandProvider,
} from "./angle-demand-sweep";

interface CapturedQuery {
  table: string;
  selectCols: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
}

/** Fake admin — captures the .from().select().eq().ilike() chain against product_seo_keywords
 *  and resolves with the fixed row set the test supplies. Sufficient for the SDK's single
 *  read path; no other Supabase methods are exercised. */
function makeFakeAdmin(rowsByTable: Record<string, unknown[]>): { admin: unknown; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const admin = {
    from(table: string) {
      const q: CapturedQuery = { table, selectCols: "", filters: [] };
      queries.push(q);
      const builder = {
        select(cols: string) {
          q.selectCols = cols;
          return builder;
        },
        eq(column: string, value: unknown) {
          q.filters.push({ op: "eq", column, value });
          return builder;
        },
        ilike(column: string, value: unknown) {
          q.filters.push({ op: "ilike", column, value });
          return Promise.resolve({ data: rowsByTable[table] ?? [], error: null });
        },
      };
      return builder;
    },
  };
  return { admin, queries };
}

test("(i) a keyword row with volume >= HIGH_MIN_VOLUME → tier:'high' + rawVolume + source:'product_seo_keywords'", async () => {
  resetSearchDemandProvider();
  const { admin } = makeFakeAdmin({
    product_seo_keywords: [
      { keyword: "collagen wrinkles serum", monthly_searches: 4200, search_console_impressions: 300 },
      { keyword: "collagen sleep", monthly_searches: 50, search_console_impressions: null },
    ],
  });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles and aging skin",
  });
  assert.equal(out.tier, "high");
  assert.equal(out.rawVolume, 4500); // 4200 + 300, the max matching row (the "collagen sleep" row doesn't match the "wrinkles" problem token)
  assert.equal(out.source, "product_seo_keywords");
});

test("(ii) unknown ingredient (no matching product_seo_keywords row) → the stub provider fires", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "hypothetical-unicorn-mushroom",
    problem: "cosmic clarity",
  });
  assert.equal(out.tier, "medium");
  assert.equal(out.rawVolume, null);
  assert.equal(out.source, "stub");
  // The read STILL went to product_seo_keywords (empty result) before the stub fell through.
  assert.equal(queries[0]?.table, "product_seo_keywords");
});

test("(iii) defense-in-depth: the arg surface cannot smuggle a select list — the SDK reads a FIXED column set regardless of input", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  // Even with an adversarial ingredient string that resembles a Postgres identifier, the SDK
  // must NEVER echo it into the SELECT/FILTER surface as an identifier — it can only appear as
  // a bound VALUE inside the ilike pattern.
  const adversarial = "keyword; select * from workspaces --";
  await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: adversarial,
    problem: "wrinkles",
  });
  const q = queries[0]!;
  assert.equal(q.table, "product_seo_keywords");
  // Fixed allowlist — no dynamic column, no SELECT *.
  assert.equal(q.selectCols, "keyword, monthly_searches, search_console_impressions");
  const ilike = q.filters.find((f) => f.op === "ilike");
  assert.ok(ilike, "ilike filter must be present");
  assert.equal(ilike!.column, "keyword", "the ilike column is fixed to `keyword`, never derived from input");
  assert.equal(ilike!.value, `%${adversarial}%`, "input goes into the VALUE side of a bound parameter, never the identifier side");
  const eq = q.filters.find((f) => f.op === "eq" && f.column === "workspace_id");
  assert.ok(eq, "workspace_id scope must always be applied");
  assert.equal(eq!.value, "ws-1");
});

test("tier boundaries: 999 -> medium, 1000 -> high, 100 -> medium, 99 -> low", () => {
  assert.equal(tierForVolume(HIGH_MIN_VOLUME - 1), "medium");
  assert.equal(tierForVolume(HIGH_MIN_VOLUME), "high");
  assert.equal(tierForVolume(MEDIUM_MIN_VOLUME), "medium");
  assert.equal(tierForVolume(MEDIUM_MIN_VOLUME - 1), "low");
  assert.equal(tierForVolume(0), "low");
});

test("named constants stay tunable (not magic numbers) — HIGH_MIN_VOLUME=1000, MEDIUM_MIN_VOLUME=100", () => {
  assert.equal(HIGH_MIN_VOLUME, 1000);
  assert.equal(MEDIUM_MIN_VOLUME, 100);
});

test("problemTokens drops stopwords + short tokens and lowercases", () => {
  assert.deepEqual(problemTokens("Wrinkles and Aging Skin"), ["wrinkles", "aging", "skin"]);
  assert.deepEqual(problemTokens("gut  --  bloating!!"), ["gut", "bloating"]);
  assert.deepEqual(problemTokens(""), []);
});

test("stubProvider returns the neutral medium tier so a demand-blind lane doesn't score high by accident", async () => {
  const out = await stubProvider({ workspaceId: "ws-1", ingredient: "x", problem: "y" });
  assert.deepEqual(out, { tier: "medium", rawVolume: null, source: "stub" });
});

test("setSearchDemandProvider swaps the hook (future paid-source spec) — resetSearchDemandProvider restores the stub", async () => {
  const custom: SearchDemandProvider = async () => ({ tier: "low", rawVolume: 7, source: "test-provider" });
  setSearchDemandProvider(custom);
  const { admin } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles",
  });
  assert.deepEqual(out, { tier: "low", rawVolume: 7, source: "test-provider" });
  resetSearchDemandProvider();
  const out2 = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "collagen",
    problem: "wrinkles",
  });
  assert.equal(out2.source, "stub");
});

test("empty ingredient short-circuits to the provider (never reads product_seo_keywords)", async () => {
  resetSearchDemandProvider();
  const { admin, queries } = makeFakeAdmin({ product_seo_keywords: [] });
  const out = await fetchSearchDemand({
    admin: admin as never,
    workspaceId: "ws-1",
    ingredient: "   ",
    problem: "wrinkles",
  });
  assert.equal(out.source, "stub");
  assert.equal(queries.length, 0, "no DB read happens for an empty ingredient — the provider handles it");
});
