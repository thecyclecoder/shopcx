/**
 * Pins the two-branch pre-Shopify guard in `closeReturn` (Phase 2 of the
 * closereturn-graceful-noop-on-internal-path-returns spec).
 *
 * Phase 1 split the single `!ret?.shopify_return_gid` early-return into:
 *   1. `!ret`               → { success: false, error: "Return not found" }
 *   2. `!ret.shopify_return_gid` (row exists, gid null — the internal
 *                             createFullReturn path)
 *                            → { success: true }, no Shopify GraphQL call
 *
 * These tests pin BOTH branches and prove the null-gid path never reaches
 * `getShopifyCredentials` / `fetch`, so the recurring Control Tower signature
 * `closeReturn failed for … Return not found or missing Shopify GID` cannot
 * fire on an internal-path row again.
 *
 * We stub the Supabase admin client + the shopify-sync credentials fetcher
 * through Node's ESM cache BEFORE dynamic-importing `./shopify-returns`,
 * same pattern returns.onfailure.test.ts already uses.
 *
 * Run:
 *   npx tsx --test src/lib/shopify-returns.closeReturn.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

type Row = { shopify_return_gid: string | null } | null;

let currentRow: Row = null;
let shopifyCredentialsCalls = 0;
let fetchCalls = 0;

function resetWorld(): void {
  currentRow = null;
  shopifyCredentialsCalls = 0;
  fetchCalls = 0;
}

interface QueryBuilder {
  select(cols: string): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  update(row: Record<string, unknown>): QueryBuilder;
  single(): Promise<{ data: Row; error: null }>;
}

function makeFrom(_table: string): QueryBuilder {
  const builder: QueryBuilder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    update() {
      return builder;
    },
    async single() {
      return { data: currentRow, error: null };
    },
  };
  return builder;
}

const stubAdmin = { from: (table: string) => makeFrom(table) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleAny = Module as unknown as { _cache: Record<string, { exports: unknown }> };
moduleAny._cache[require.resolve("@/lib/supabase/admin")] = {
  exports: { createAdminClient: () => stubAdmin },
};
moduleAny._cache[require.resolve("@/lib/shopify-sync")] = {
  exports: {
    getShopifyCredentials: async () => {
      shopifyCredentialsCalls += 1;
      // If the guard ever falls through on the null-gid branch this would fire
      // and the assertion in the null-gid test would catch it.
      return { shop: "test.myshopify.com", accessToken: "stub" };
    },
  },
};
// Fail loud if anything tries to reach real Shopify — the null-gid branch
// must not perform any network I/O.
const originalFetch = global.fetch;
global.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("fetch should not be called on null-gid path");
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { closeReturn } = require("./shopify-returns") as typeof import("./shopify-returns");

const WORKSPACE_ID = "ws-1";
const RETURN_ID = "ret-1";

// ── Branch 1: missing DB row ─────────────────────────────────────────

test("closeReturn: missing DB row → success:false with 'Return not found' error", async () => {
  resetWorld();
  currentRow = null;

  const r = await closeReturn(WORKSPACE_ID, RETURN_ID);

  assert.equal(r.success, false);
  assert.equal(r.error, "Return not found");
  assert.equal(shopifyCredentialsCalls, 0, "must not call getShopifyCredentials");
  assert.equal(fetchCalls, 0, "must not touch Shopify");
});

// ── Branch 2: internal-path row (row exists, gid null) ───────────────

test("closeReturn: row with null shopify_return_gid → success:true no-op, no Shopify call", async () => {
  resetWorld();
  currentRow = { shopify_return_gid: null };

  const r = await closeReturn(WORKSPACE_ID, RETURN_ID);

  assert.equal(r.success, true, "internal-path row must be a graceful no-op");
  assert.equal(r.error, undefined, "no error on the documented no-op path");
  assert.equal(shopifyCredentialsCalls, 0, "must not fetch Shopify credentials");
  assert.equal(fetchCalls, 0, "must not touch Shopify");
});

// ── Restore ──────────────────────────────────────────────────────────

test("teardown: restore global.fetch", () => {
  global.fetch = originalFetch;
});
