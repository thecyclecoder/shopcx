/**
 * hero-product-advertising-gate Phase 2 verification — Dahlia's cadence enumeration only
 * dispatches ad-creative jobs for advertised products, even when an attachment SKU carries a
 * `product_ad_angles` row. Given an advertised product A and an attachment product Z that each
 * have an angle row, the enumeration yields A and NOT Z.
 *
 *   npm run test:ad-creative-cadence-gate
 *   (= tsx --test src/lib/inngest/ad-creative-cadence.gate.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { createAdminClient } from "@/lib/supabase/admin";

import { dispatchAdCreativeCadence } from "./ad-creative-cadence";

type Admin = ReturnType<typeof createAdminClient>;

interface Store {
  product_ad_angles: Array<{ workspace_id: string; product_id: string }>;
  products: Array<{ id: string; workspace_id: string; is_advertised: boolean }>;
  ad_campaigns: Array<{ id: string; workspace_id: string; product_id: string | null }>;
  agent_jobs: Array<{ id: string; workspace_id: string; kind: string; status: string; instructions: string | null; created_at: string }>;
  ad_videos: Array<Record<string, unknown>>;
  meta_attribution_daily: Array<Record<string, unknown>>;
  workspaces: Array<Record<string, unknown>>;
}

// A tiny Supabase-shaped chain — supports `.select().eq().eq().in().gte()` for reads,
// `.select().eq().eq().in()` for the ad-campaigns depth read, and `.insert({...})` for the
// agent_jobs write. Enough for the cadence code path.
function makeAdmin(store: Store): { admin: Admin; inserts: Array<{ table: string; row: Record<string, unknown> }> } {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const admin = {
    from(table: string) {
      const state = { filters: [] as Array<{ col: string; op: "eq" | "in" | "gte"; val: unknown }>, columns: "" as string };
      let mode: "select" | "insert" = "select";
      let insertRow: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = (cols?: string) => {
        state.columns = cols ?? "*";
        return chain;
      };
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
      chain.insert = (row: Record<string, unknown>) => {
        mode = "insert";
        insertRow = row;
        return chain;
      };
      const rowsFor = (t: string): Array<Record<string, unknown>> => {
        return (store as unknown as Record<string, Array<Record<string, unknown>>>)[t] ?? [];
      };
      const runSelect = () => {
        const rows = rowsFor(table);
        return rows.filter((r) =>
          state.filters.every((f) => {
            const v = r[f.col];
            if (f.op === "eq") return v === f.val;
            if (f.op === "in") return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
            if (f.op === "gte") return typeof v === "string" && typeof f.val === "string" && v >= f.val;
            return true;
          }),
        );
      };
      chain.then = (onFulfilled: (v: { data: unknown; error: null }) => unknown) => {
        if (mode === "insert") {
          inserts.push({ table, row: insertRow });
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        }
        return Promise.resolve({ data: runSelect(), error: null }).then(onFulfilled);
      };
      return chain;
    },
  } as unknown as Admin;
  return { admin, inserts };
}

const WS = "ws-superfoods";
const HERO = "prod-hero-coffee";
const ATTACHMENT = "prod-tumbler";

function baseStore(): Store {
  return {
    product_ad_angles: [
      { workspace_id: WS, product_id: HERO },
      { workspace_id: WS, product_id: ATTACHMENT }, // ⚠ stray attachment angle
    ],
    products: [
      { id: HERO, workspace_id: WS, is_advertised: true },
      { id: ATTACHMENT, workspace_id: WS, is_advertised: false },
    ],
    ad_campaigns: [], // empty bin — every eligible product falls below floor
    agent_jobs: [],
    ad_videos: [],
    meta_attribution_daily: [],
    workspaces: [],
  };
}

test("Dahlia enumeration yields the advertised product and NOT the attachment SKU (even with a stray angle row)", async () => {
  const store = baseStore();
  const { admin, inserts } = makeAdmin(store);
  const result = await dispatchAdCreativeCadence(admin, WS, /* binFloor */ 1);

  const dispatchedProducts = inserts
    .filter((i) => i.table === "agent_jobs" && i.row["kind"] === "ad-creative")
    .map((i) => {
      const parsed = JSON.parse(String(i.row["instructions"]));
      return parsed.product_id as string;
    });

  assert.ok(dispatchedProducts.includes(HERO), "advertised hero product must be dispatched");
  assert.ok(!dispatchedProducts.includes(ATTACHMENT), "attachment SKU must NEVER be dispatched");
  assert.equal(result.dispatched, 1, "exactly one dispatch for the one advertised product");
});

test("Dahlia enumeration returns zero dispatches when no products are advertised", async () => {
  const store = baseStore();
  store.products = [
    { id: HERO, workspace_id: WS, is_advertised: false },
    { id: ATTACHMENT, workspace_id: WS, is_advertised: false },
  ];
  const { admin, inserts } = makeAdmin(store);
  const result = await dispatchAdCreativeCadence(admin, WS, 1);
  assert.equal(result.evaluated, 0);
  assert.equal(result.dispatched, 0);
  assert.equal(inserts.filter((i) => i.table === "agent_jobs").length, 0);
});
