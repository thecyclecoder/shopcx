/**
 * Unit tests for the find_products_for_situation grouping + synonym expansion
 * (customer-situations-all-products Phase 2). Covers the exact pre-Phase-2 failing state — the top
 * matches could be three rows of the SAME product — and the fix: the best situation PER product,
 * top 3 DISTINCT products, with a light synonym map so "morning coffee" reaches a coffee product.
 *
 * Run:  npx tsx --test src/lib/shopping-agent/tools.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { expandSituationWords, bestSituationsByProduct } from "./tools";
import type { CustomerSituationRow } from "@/lib/customer-situations";

/** Minimal CustomerSituationRow for the pure ranking helpers (DB-free). */
function row(productId: string, slug: string, text: string): CustomerSituationRow {
  return {
    id: `${productId}-${slug}`,
    workspace_id: "ws",
    product_id: productId,
    slug,
    situation: text,
    who: null,
    goal: null,
    noticed: null,
    timeframe: null,
    verbatim_phrase: null,
    review_ids: [],
    quotes: [],
    compliance_ok: true,
    compliance_note: null,
    source: "mine:2026-11-28",
    active: true,
    created_at: "2026-11-28T00:00:00.000Z",
    updated_at: "2026-11-28T00:00:00.000Z",
  };
}

test("synonym expansion: 'morning' pulls in coffee/latte, 'stress' pulls in sleep/calm", () => {
  const e1 = expandSituationWords(["morning"]);
  assert.ok(e1.includes("coffee") && e1.includes("latte"));
  const e2 = expandSituationWords(["stress"]);
  assert.ok(e2.includes("sleep") && e2.includes("calm"));
  // A word in no group is untouched (no spurious expansion).
  assert.deepEqual(expandSituationWords(["banana"]).sort(), ["banana"]);
});

test("returns the best situation PER product, not three rows of the same product", () => {
  const situations = [
    row("coffee", "morning-swap", "wanted a healthier morning coffee"),
    row("coffee", "afternoon", "needed an afternoon coffee pick-me-up"),
    row("coffee", "latte", "make a morning latte at home"),
    row("creamer", "coffee-creamer", "a cleaner creamer for my morning coffee"),
    row("focus", "work", "needed focus for work"),
  ];
  const chosen = bestSituationsByProduct(situations, ["morning", "coffee"], 3);
  const productIds = chosen.map((s) => s.product_id);
  // Every returned product is distinct — the core Phase-2 guarantee.
  assert.equal(new Set(productIds).size, productIds.length);
  // Coffee appears at most once despite three coffee situations matching.
  assert.equal(productIds.filter((p) => p === "coffee").length, 1);
});

test("'morning coffee' situation surfaces the coffee product via the synonym map", () => {
  const situations = [
    row("coffee", "morning-energy", "customers wanted steady morning energy"),
    row("tabs", "cravings", "fewer cravings between meals"),
  ];
  // The shopper never typed "energy"; "morning" + the synonym map must still reach the coffee row.
  const chosen = bestSituationsByProduct(situations, ["morning"], 3);
  assert.ok(chosen.some((s) => s.product_id === "coffee"), "coffee product should be recommended");
});

test("caps at maxProducts distinct products, ordered by best score", () => {
  const situations = [
    row("a", "s", "focus focus focus work study"),
    row("b", "s", "focus work"),
    row("c", "s", "focus"),
    row("d", "s", "focus"),
  ];
  const chosen = bestSituationsByProduct(situations, ["focus", "work", "study"], 3);
  assert.equal(chosen.length, 3);
  assert.equal(chosen[0].product_id, "a"); // highest overlap first
});

test("no match → empty (no recommendation forced)", () => {
  const situations = [row("a", "s", "steady morning energy")];
  assert.deepEqual(bestSituationsByProduct(situations, ["marathon"], 3), []);
});
