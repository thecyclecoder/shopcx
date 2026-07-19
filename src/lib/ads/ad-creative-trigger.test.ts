import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdGenerationInstructions, AD_CREATIVE_SESSION_KIND } from "@/lib/ads/ad-creative-trigger";

test("the session kind is the box-session-forcing copy-author kind (never the deterministic-prone 'ad-creative')", () => {
  assert.equal(AD_CREATIVE_SESSION_KIND, "ad-creative-copy-author");
});

test("defaults: temperature cold, count 1, no reason", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1" });
  assert.deepEqual(instr, { product_id: "p1", count: 1, temperature: "cold" });
});

test("honours an explicit temperature", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1", temperature: "warm" });
  assert.equal(instr.temperature, "warm");
});

test("honours count + reason", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1", temperature: "hot", count: 3, reason: "ceo-manual" });
  assert.deepEqual(instr, { product_id: "p1", count: 3, temperature: "hot", trigger_reason: "ceo-manual" });
});

test("reason is omitted from the payload when not provided (no null pollution)", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1" });
  assert.equal("trigger_reason" in instr, false);
});
