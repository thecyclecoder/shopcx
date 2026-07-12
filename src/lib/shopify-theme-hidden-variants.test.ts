/**
 * Failing-state-first tests for the theme suppression patchers
 * ([[./shopify-theme-hidden-variants]]).
 *
 *   npx tsx --test src/lib/shopify-theme-hidden-variants.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { patchLiquidVariantExclusion, patchJsonForSl, patchHiddenVariantsSetting } from "./shopify-theme-hidden-variants";

const MB = "42614433546413"; // Mixed Berry (test placeholder — real id looked up at runtime)
const SL = "42614433480877"; // Strawberry Lemonade — SC-TABS-SL-2 (canonical for this spec)

// ── patchLiquidVariantExclusion — the primary patcher ─────────────

test("Liquid: `unless variant.id == MB` → adds `or variant.id == SL` (customize-flavor skip)", () => {
  const before = `{% unless variant.id == ${MB} %}option{% endunless %}`;
  const after = patchLiquidVariantExclusion(before, MB, SL);
  assert.equal(after, `{% unless variant.id == ${MB} or variant.id == ${SL} %}option{% endunless %}`);
});

test("Liquid: `if variant.id == MB` in a loop skip → adds `or variant.id == SL`", () => {
  const before = `{% if variant.id == ${MB} %}{% continue %}{% endif %}`;
  const after = patchLiquidVariantExclusion(before, MB, SL);
  assert.equal(after, `{% if variant.id == ${MB} or variant.id == ${SL} %}{% continue %}{% endif %}`);
});

test("Liquid: `if variant.id != MB` (keep-if-not) → adds `and variant.id != SL`", () => {
  const before = `{% if variant.id != ${MB} %}render{% endif %}`;
  const after = patchLiquidVariantExclusion(before, MB, SL);
  assert.equal(after, `{% if variant.id != ${MB} and variant.id != ${SL} %}render{% endif %}`);
});

test("Liquid: idempotent — a second run returns null once SL is present", () => {
  const before = `{% unless variant.id == ${MB} or variant.id == ${SL} %}option{% endunless %}`;
  assert.equal(patchLiquidVariantExclusion(before, MB, SL), null);
});

test("Liquid: no MB reference → null (nothing to anchor SL on)", () => {
  const before = `{% for variant in product.variants %}{{ variant.title }}{% endfor %}`;
  assert.equal(patchLiquidVariantExclusion(before, MB, SL), null);
});

test("Liquid: whole-token guard — MB as a prefix of a longer id is NOT patched", () => {
  const longer = `${MB}9`;
  const before = `{% if variant.id == ${longer} %}skip{% endif %}`;
  assert.equal(patchLiquidVariantExclusion(before, MB, SL), null);
});

test("Liquid: multiple `variant.id == MB` occurrences → all get extended", () => {
  const before = `{% if variant.id == ${MB} %}a{% endif %}
{% unless variant.id == ${MB} %}b{% endunless %}`;
  const after = patchLiquidVariantExclusion(before, MB, SL);
  assert.equal(
    after,
    `{% if variant.id == ${MB} or variant.id == ${SL} %}a{% endif %}
{% unless variant.id == ${MB} or variant.id == ${SL} %}b{% endunless %}`,
  );
});

// ── patchJsonForSl — the "MB → MB,SL" adjacency patch (JSON fallback) ─

test("JSON array entry: '\"MB\"' becomes '\"MB\",\"SL\"'", () => {
  const before = `{"hidden_variants":["${MB}"]}`;
  const after = patchJsonForSl(before, MB, SL);
  assert.equal(after, `{"hidden_variants":["${MB}","${SL}"]}`);
});

test("JSON: idempotent when SL is already present", () => {
  const before = `{"hidden_variants":["${MB}","${SL}"]}`;
  assert.equal(patchJsonForSl(before, MB, SL), null);
});

// ── patchHiddenVariantsSetting — Dawn's "hidden_variants": "…" (fallback) ─

test("Dawn shape: appends SL to a populated CSV, preserves original spacing", () => {
  const before = `"settings":{"hidden_variants":"${MB}"}`;
  const after = patchHiddenVariantsSetting(before, SL);
  assert.equal(after, `"settings":{"hidden_variants":"${MB},${SL}"}`);
});

test("Dawn shape: empty CSV → writes SL alone (no leading comma)", () => {
  const before = `"settings":{"hidden_variants":""}`;
  const after = patchHiddenVariantsSetting(before, SL);
  assert.equal(after, `"settings":{"hidden_variants":"${SL}"}`);
});

test("Dawn shape: already contains SL → null", () => {
  const before = `"settings":{"hidden_variants":"${MB},${SL}"}`;
  assert.equal(patchHiddenVariantsSetting(before, SL), null);
});
