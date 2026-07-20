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

test("pins a specific competitor ad (competitor_skeleton_id) when provided", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1", competitorSkeletonId: "sk-123" });
  assert.equal(instr.competitor_skeleton_id, "sk-123");
});

test("competitor_skeleton_id is omitted when not pinned (no null pollution → shelf-ranked)", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1", temperature: "cold" });
  assert.equal("competitor_skeleton_id" in instr, false);
});

test("carries owner notes (trimmed) when provided", () => {
  const instr = buildAdGenerationInstructions({ productId: "p1", notes: "  remove the free tote badge  " });
  assert.equal(instr.notes, "remove the free tote badge");
});

test("notes is omitted when blank/whitespace (no null pollution)", () => {
  assert.equal("notes" in buildAdGenerationInstructions({ productId: "p1" }), false);
  assert.equal("notes" in buildAdGenerationInstructions({ productId: "p1", notes: "   " }), false);
});
