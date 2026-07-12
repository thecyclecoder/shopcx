/**
 * Failing-state-first tests for the setStorefrontAvailability idempotency
 * contract ([[./storefront-availability]]) + the theme reverse patchers
 * ([[../shopify-theme-hidden-variants]]).
 *
 * Pins the ⭐ Idempotency guard the spec verification bullet requires:
 * a variant already in the target state → no write. Covers both the portal
 * delta and every Liquid/JSON/Dawn reverse-patch shape.
 *
 *   npx tsx --test src/lib/logistics/storefront-availability.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeSuppressionDelta } from "./storefront-availability";
import {
  unpatchLiquidVariantExclusion,
  unpatchJsonForVariant,
  unpatchHiddenVariantsSetting,
  patchLiquidVariantExclusion,
  patchHiddenVariantsSetting,
} from "../shopify-theme-hidden-variants";

const V = "42614433480877";
const A = "42614433546413"; // anchor / peer variant

// ── computeSuppressionDelta — the portal-side idempotency predicate ────

test("delta: available=false and variant already suppressed → changed=false (no DB write)", () => {
  const cur = new Set([V, A]);
  const d = computeSuppressionDelta(cur, V, false);
  assert.equal(d.changed, false);
  assert.deepEqual(d.next.sort(), [A, V].sort());
});

test("delta: available=true and variant already NOT suppressed → changed=false", () => {
  const cur = new Set([A]);
  const d = computeSuppressionDelta(cur, V, true);
  assert.equal(d.changed, false);
  assert.deepEqual(d.next, [A]);
});

test("delta: available=false + variant NOT in set → adds it, changed=true", () => {
  const cur = new Set([A]);
  const d = computeSuppressionDelta(cur, V, false);
  assert.equal(d.changed, true);
  assert.deepEqual(d.next.sort(), [A, V].sort());
});

test("delta: available=true + variant IS in set → removes it, changed=true", () => {
  const cur = new Set([V, A]);
  const d = computeSuppressionDelta(cur, V, true);
  assert.equal(d.changed, true);
  assert.deepEqual(d.next, [A]);
});

// ── unpatchLiquidVariantExclusion — mirror of patchLiquidVariantExclusion ─

test("unpatch Liquid: `A or V` → `A` (removes trailing conjunction)", () => {
  const before = `{% unless variant.id == ${A} or variant.id == ${V} %}option{% endunless %}`;
  const after = unpatchLiquidVariantExclusion(before, V);
  assert.equal(after, `{% unless variant.id == ${A} %}option{% endunless %}`);
});

test("unpatch Liquid: `V or A` → `A` (removes leading conjunction)", () => {
  const before = `{% unless variant.id == ${V} or variant.id == ${A} %}option{% endunless %}`;
  const after = unpatchLiquidVariantExclusion(before, V);
  assert.equal(after, `{% unless variant.id == ${A} %}option{% endunless %}`);
});

test("unpatch Liquid: `!=` conjunction with `and` reverses too", () => {
  const before = `{% if variant.id != ${A} and variant.id != ${V} %}render{% endif %}`;
  const after = unpatchLiquidVariantExclusion(before, V);
  assert.equal(after, `{% if variant.id != ${A} %}render{% endif %}`);
});

test("unpatch Liquid: idempotent — a second run returns null once V is gone", () => {
  const before = `{% unless variant.id == ${A} %}option{% endunless %}`;
  assert.equal(unpatchLiquidVariantExclusion(before, V), null);
});

test("unpatch Liquid: whole-token guard — V as a prefix of a longer id is NOT touched", () => {
  const longer = `${V}9`;
  const before = `{% if variant.id == ${longer} %}skip{% endif %}`;
  assert.equal(unpatchLiquidVariantExclusion(before, V), null);
});

test("unpatch → repatch roundtrip preserves the original", () => {
  const original = `{% unless variant.id == ${A} %}option{% endunless %}`;
  const patched = patchLiquidVariantExclusion(original, A, V);
  assert.ok(patched && patched.includes(V));
  const un = unpatchLiquidVariantExclusion(patched!, V);
  assert.equal(un, original);
});

// ── unpatchJsonForVariant — mirror of patchJsonForSl ───────────────────

test("unpatch JSON array: `[\"A\",\"V\"]` → `[\"A\"]`", () => {
  const before = `{"hidden_variants":["${A}","${V}"]}`;
  const after = unpatchJsonForVariant(before, V);
  assert.equal(after, `{"hidden_variants":["${A}"]}`);
});

test("unpatch JSON array: idempotent when V absent", () => {
  const before = `{"hidden_variants":["${A}"]}`;
  assert.equal(unpatchJsonForVariant(before, V), null);
});

// ── unpatchHiddenVariantsSetting — mirror of patchHiddenVariantsSetting ─

test("Dawn shape: `\"A,V\"` → `\"A\"` (V removed from CSV)", () => {
  const before = `"settings":{"hidden_variants":"${A},${V}"}`;
  const after = unpatchHiddenVariantsSetting(before, V);
  assert.equal(after, `"settings":{"hidden_variants":"${A}"}`);
});

test("Dawn shape: single-element CSV `\"V\"` → `\"\"` (empty CSV)", () => {
  const before = `"settings":{"hidden_variants":"${V}"}`;
  const after = unpatchHiddenVariantsSetting(before, V);
  assert.equal(after, `"settings":{"hidden_variants":""}`);
});

test("Dawn shape: idempotent when V absent", () => {
  const before = `"settings":{"hidden_variants":"${A}"}`;
  assert.equal(unpatchHiddenVariantsSetting(before, V), null);
});

test("Dawn shape: patch → unpatch roundtrip preserves the original", () => {
  const original = `"settings":{"hidden_variants":"${A}"}`;
  const patched = patchHiddenVariantsSetting(original, V);
  assert.ok(patched);
  const un = unpatchHiddenVariantsSetting(patched!, V);
  assert.equal(un, original);
});
