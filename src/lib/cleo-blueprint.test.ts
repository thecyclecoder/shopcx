/**
 * Unit tests for the Phase 1 category matcher + `(product_id, funnel_type)` dedup key
 * (docs/brain/specs/cleo-blueprint-product-matching.md). Pure — no DB, no clock.
 *
 * Pins the three cases the spec verification calls out:
 *   • superfood-coffee teardown → Amazing Coffee (head-noun `coffee` in blob)
 *   • longevity teardown → null (no product's head-noun / tokens overlap; skip)
 *   • two advertorial teardowns for one product → ONE blueprint (dedup key holds)
 *
 * Run:
 *   npm run test:cleo-blueprint
 *   (= tsx --test src/lib/cleo-blueprint.test.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ResearchUrl, TeardownRecipe } from "./research-urls";
import {
  blueprintDedupKey,
  matchProductToTeardown,
  productHeadNoun,
  teardownMatchBlob,
  tokenizeForMatch,
  type ProductForMatch,
} from "./cleo-blueprint";

const PRODUCTS: ProductForMatch[] = [
  { id: "p-coffee", title: "Amazing Coffee", handle: "amazing-coffee" },
  { id: "p-tabs", title: "Superfood Tabs", handle: "superfood-tabs" },
  { id: "p-tea", title: "Longevity Tea", handle: "longevity-tea" },
];

function recipe(overrides: Partial<TeardownRecipe> = {}): TeardownRecipe {
  return {
    funnel_type: "advertorial",
    strategy: "one-sentence strategy",
    architecture: [{ chapter_role: "hero", purpose: "grab attention" }],
    levers: [{ lever: "urgency", evidence: "" }],
    offer: { options: 1 },
    transferable_pattern: "generic transferable pattern",
    ...overrides,
  };
}

function teardown(overrides: {
  brand?: string | null;
  recipe?: TeardownRecipe | null;
} = {}): Pick<ResearchUrl, "brand" | "teardown"> {
  return {
    brand: overrides.brand ?? null,
    teardown: overrides.recipe === undefined ? recipe() : overrides.recipe,
  };
}

// ── tokenizeForMatch / productHeadNoun / teardownMatchBlob ────────────────────

test("tokenizeForMatch: lowercases, splits on non-word, drops stopwords + length<2", () => {
  assert.deepEqual(tokenizeForMatch("Amazing Coffee"), ["amazing", "coffee"]);
  assert.deepEqual(tokenizeForMatch("amazing-coffee"), ["amazing", "coffee"]);
  assert.deepEqual(tokenizeForMatch("The Longevity Answer"), ["longevity", "answer"]);
  assert.deepEqual(tokenizeForMatch("  Super_Food, Tabs!  "), ["super", "food", "tabs"]);
  assert.deepEqual(tokenizeForMatch(""), []);
});

test("productHeadNoun: last non-stopword token wins", () => {
  assert.equal(productHeadNoun("Amazing Coffee"), "coffee");
  assert.equal(productHeadNoun("Superfood Tabs"), "tabs");
  assert.equal(productHeadNoun("The Longevity Answer"), "answer");
  assert.equal(productHeadNoun(""), null);
});

test("teardownMatchBlob: joins brand + funnel_type + strategy + transferable_pattern", () => {
  const t = teardown({
    brand: "Kickstart",
    recipe: recipe({
      funnel_type: "advertorial",
      strategy: "long-form",
      transferable_pattern: "superfood coffee morning ritual",
    }),
  });
  const blob = teardownMatchBlob(t.brand, t.teardown);
  assert.match(blob, /Kickstart/);
  assert.match(blob, /advertorial/);
  assert.match(blob, /long-form/);
  assert.match(blob, /superfood coffee morning ritual/);
});

test("teardownMatchBlob: missing brand or recipe → still deterministic", () => {
  assert.equal(teardownMatchBlob(null, null), "");
  assert.equal(teardownMatchBlob(null, recipe({ funnel_type: "quiz", strategy: "", transferable_pattern: "" })), "quiz");
});

// ── matchProductToTeardown — the three spec-pinned cases ─────────────────────

test("superfood-coffee teardown → Amazing Coffee (head-noun 'coffee' wins over Tabs)", () => {
  const t = teardown({
    brand: "Kickstart Coffee",
    recipe: recipe({
      funnel_type: "advertorial",
      strategy: "morning coffee ritual",
      transferable_pattern: "a superfood coffee product that replaces the morning cup",
    }),
  });
  const match = matchProductToTeardown(t, PRODUCTS);
  assert.ok(match, "expected a match");
  assert.equal(match!.id, "p-coffee");
});

test("superfood-coffee teardown does NOT map to Superfood Tabs (head-noun beats a shared 'superfood' token)", () => {
  const t = teardown({
    brand: null,
    recipe: recipe({
      funnel_type: "advertorial",
      strategy: "",
      transferable_pattern: "superfood coffee drink for energy",
    }),
  });
  const match = matchProductToTeardown(t, PRODUCTS);
  assert.equal(match?.id, "p-coffee");
});

test("longevity/anti-aging teardown → null (no product's head-noun/tokens hit the blob)", () => {
  const t = teardown({
    brand: "Elysium",
    recipe: recipe({
      funnel_type: "quiz",
      strategy: "anti-aging routine",
      transferable_pattern: "an anti-aging supplement for skin cellular repair",
    }),
  });
  const match = matchProductToTeardown(t, PRODUCTS);
  assert.equal(match, null);
});

test("longevity teardown WITH 'Longevity Tea' in the catalog → matches Longevity Tea (head-noun 'tea' or 'longevity' shared)", () => {
  const t = teardown({
    brand: null,
    recipe: recipe({
      funnel_type: "advertorial",
      strategy: "longevity daily tea",
      transferable_pattern: "a longevity tea for daily wellness",
    }),
  });
  const match = matchProductToTeardown(t, PRODUCTS);
  assert.equal(match?.id, "p-tea");
});

test("empty catalog → null (nothing to match)", () => {
  const t = teardown({ recipe: recipe({ transferable_pattern: "coffee" }) });
  assert.equal(matchProductToTeardown(t, []), null);
});

test("empty teardown blob (no brand, no recipe) → null", () => {
  const t = teardown({ brand: null, recipe: null });
  assert.equal(matchProductToTeardown(t, PRODUCTS), null);
});

test("tie on score → first product in input order wins (deterministic)", () => {
  const twoCoffees: ProductForMatch[] = [
    { id: "p-first", title: "Amazing Coffee", handle: null },
    { id: "p-second", title: "Amazing Coffee", handle: null },
  ];
  const t = teardown({
    brand: null,
    recipe: recipe({ transferable_pattern: "amazing coffee morning ritual" }),
  });
  const match = matchProductToTeardown(t, twoCoffees);
  assert.equal(match?.id, "p-first");
});

// ── blueprintDedupKey — the sweep's `(product_id, funnel_type)` dedup key ────

test("blueprintDedupKey: same (product_id, funnel_type) → same key (Set dedup works)", () => {
  const seen = new Set<string>();
  const products = [{ id: "p-coffee", type: "advertorial" }, { id: "p-coffee", type: "advertorial" }, { id: "p-coffee", type: "listicle" }];
  for (const p of products) seen.add(blueprintDedupKey(p.id, p.type));
  // Two advertorials collapse to ONE, listicle is its own key → 2 unique keys total.
  assert.equal(seen.size, 2);
});

test("blueprintDedupKey: different products with same funnel_type do NOT collide", () => {
  assert.notEqual(
    blueprintDedupKey("p-coffee", "advertorial"),
    blueprintDedupKey("p-tabs", "advertorial"),
  );
});

test("blueprintDedupKey: trims funnel_type so ' advertorial ' and 'advertorial' collide", () => {
  assert.equal(blueprintDedupKey("p-coffee", " advertorial "), blueprintDedupKey("p-coffee", "advertorial"));
});
