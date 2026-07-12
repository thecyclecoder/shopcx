/**
 * Unit tests for the hero-product advertising gate — the shared filter the Phase-2 pipelines read.
 *
 *   npm run test:advertised-products
 *   (= tsx --test src/lib/advertised-products.test.ts)
 *
 * Fake admin client answers `.from("products").select("id").eq(...).eq(...)` and the maybeSingle
 * shape used by isAdvertisedProduct. No network / DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAdvertisedProduct, listAdvertisedProductIds } from "./advertised-products";

interface FakeProduct {
  id: string;
  workspace_id: string;
  is_advertised: boolean;
}

interface QueryState {
  filters: { col: string; val: unknown }[];
  columns: string[];
  single: boolean;
}

function makeAdmin(rows: FakeProduct[]): SupabaseClient {
  const admin = {
    from(table: string) {
      assert.equal(table, "products", "gate only reads from products");
      const state: QueryState = { filters: [], columns: [], single: false };
      const chain: Record<string, unknown> = {};
      chain.select = (cols: string) => {
        state.columns = cols.split(",").map((c) => c.trim());
        return chain;
      };
      chain.eq = (col: string, val: unknown) => {
        state.filters.push({ col, val });
        return chain;
      };
      chain.maybeSingle = () => {
        state.single = true;
        const filtered = rows.filter((r) =>
          state.filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
        );
        const row = filtered[0] ?? null;
        return Promise.resolve({ data: row, error: null });
      };
      chain.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) => {
        const filtered = rows.filter((r) =>
          state.filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
        );
        return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return admin;
}

const WS = "ws-superfoods";
const OTHER_WS = "ws-other";

const HERO_A = { id: "prod-hero-a", workspace_id: WS, is_advertised: true };
const HERO_B = { id: "prod-hero-b", workspace_id: WS, is_advertised: true };
const ATTACHMENT_TUMBLER = { id: "prod-tumbler", workspace_id: WS, is_advertised: false };
const ATTACHMENT_SLEEP = { id: "prod-sleep", workspace_id: WS, is_advertised: false };
const OTHER_WS_HERO = { id: "prod-other-hero", workspace_id: OTHER_WS, is_advertised: true };

test("listAdvertisedProductIds returns only is_advertised=true ids in the workspace", async () => {
  const admin = makeAdmin([HERO_A, HERO_B, ATTACHMENT_TUMBLER, ATTACHMENT_SLEEP, OTHER_WS_HERO]);
  const ids = await listAdvertisedProductIds(admin, WS);
  assert.deepEqual(new Set(ids), new Set([HERO_A.id, HERO_B.id]));
  assert.ok(!ids.includes(ATTACHMENT_TUMBLER.id), "attachment SKU tumbler must be excluded");
  assert.ok(!ids.includes(ATTACHMENT_SLEEP.id), "attachment SKU sleep gummies must be excluded");
  assert.ok(!ids.includes(OTHER_WS_HERO.id), "other workspace's hero must be excluded");
});

test("listAdvertisedProductIds returns empty array when workspace has no advertised products", async () => {
  const admin = makeAdmin([ATTACHMENT_TUMBLER, ATTACHMENT_SLEEP]);
  const ids = await listAdvertisedProductIds(admin, WS);
  assert.deepEqual(ids, []);
});

test("isAdvertisedProduct returns false for an attachment product id", async () => {
  const admin = makeAdmin([HERO_A, ATTACHMENT_TUMBLER]);
  const flagged = await isAdvertisedProduct(admin, ATTACHMENT_TUMBLER.id);
  assert.equal(flagged, false, "attachment SKU must NOT be treated as advertised");
});

test("isAdvertisedProduct returns true for a hero product id", async () => {
  const admin = makeAdmin([HERO_A, ATTACHMENT_TUMBLER]);
  const flagged = await isAdvertisedProduct(admin, HERO_A.id);
  assert.equal(flagged, true);
});

test("isAdvertisedProduct returns false for a missing/deleted product id", async () => {
  const admin = makeAdmin([HERO_A]);
  const flagged = await isAdvertisedProduct(admin, "prod-does-not-exist");
  assert.equal(flagged, false, "missing product must be treated as not advertised (safe skip)");
});
