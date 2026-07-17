/**
 * sophistication tests — pin the deterministic classification rules the
 * [[../../../docs/brain/specs/dahlia-five-frameworks-copy-skill]] spec's Phase 2 / Fix-1
 * verification list depends on. Runs via:
 *   npm run test:sophistication
 *   (or) npx tsx --test src/lib/ads/sophistication.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAngleSchwartzLevel,
  computeSophisticationLevel,
  type SchwartzLevel,
} from "./sophistication";
import type { CompetitorAngle } from "./creative-sourcing";

function makeAngle(hook: string | null, mechanismClaim: string | null): CompetitorAngle {
  return {
    advertiser: "test-advertiser",
    hook,
    framework: null,
    mechanismClaim,
    proof: null,
    offer: null,
    daysRunning: 60,
    heat: null,
    destinationDomain: null,
    imageUrl: null,
    resumeAdvertising: true,
    winnerTier: null,
    winnerScore: null,
    conceptTags: null,
  };
}

test("computeSophisticationLevel: empty shelf → 3 (safe solution-aware default)", () => {
  assert.equal(computeSophisticationLevel([]), 3);
});

test("classifyAngleSchwartzLevel: L2 problem token ('tired')", () => {
  assert.equal(classifyAngleSchwartzLevel(makeAngle("tired of the 2pm crash", null)), 2);
});

test("classifyAngleSchwartzLevel: L3 solution-category token ('clean energy')", () => {
  assert.equal(classifyAngleSchwartzLevel(makeAngle("give me clean energy", null)), 3);
});

test("classifyAngleSchwartzLevel: L4 mechanism token ('adaptogen')", () => {
  assert.equal(classifyAngleSchwartzLevel(makeAngle("real adaptogen stack", null)), 4);
});

test("classifyAngleSchwartzLevel: L5 versus-comparison token ('vs coffee')", () => {
  assert.equal(classifyAngleSchwartzLevel(makeAngle("vs coffee, half the crash", null)), 5);
});

test("classifyAngleSchwartzLevel: no benefit tokens → L1 unaware", () => {
  assert.equal(classifyAngleSchwartzLevel(makeAngle("hello world", "the daily supplement")), 1);
});

test("classifyAngleSchwartzLevel: highest-hit level wins within a single angle (mechanism beats problem)", () => {
  // Both "tired" (L2) and "adaptogen" (L4) hit; the higher level wins.
  assert.equal(classifyAngleSchwartzLevel(makeAngle("tired of the crash", "our adaptogen stack")), 4);
});

test("computeSophisticationLevel: all-L4 → 4", () => {
  const shelf = [
    makeAngle("real adaptogen stack", null),
    makeAngle("ashwagandha inside", null),
    makeAngle("l-theanine every serving", null),
  ];
  assert.equal(computeSophisticationLevel(shelf), 4);
});

test("computeSophisticationLevel: mixed L3+L4 with L4 majority → 4", () => {
  const shelf = [
    makeAngle("clean energy for the afternoon", null),
    makeAngle("real adaptogen stack", null),
    makeAngle("ashwagandha inside", null),
  ];
  assert.equal(computeSophisticationLevel(shelf), 4);
});

test("computeSophisticationLevel: tie L3+L4 → 4 (higher-wins tiebreak)", () => {
  const shelf = [
    makeAngle("clean energy for the afternoon", null),
    makeAngle("focus support all day", null),
    makeAngle("real adaptogen stack", null),
    makeAngle("l-theanine every serving", null),
  ];
  assert.equal(computeSophisticationLevel(shelf), 4);
});

test("computeSophisticationLevel: tie L4+L5 → 5 (higher-wins tiebreak — harder-to-write-against wins)", () => {
  const shelf = [
    makeAngle("real adaptogen stack", null),
    makeAngle("ashwagandha inside", null),
    makeAngle("vs coffee, half the crash", null),
    makeAngle("compared to your morning cup", null),
  ];
  assert.equal(computeSophisticationLevel(shelf), 5);
});

test("computeSophisticationLevel: return value is always in {1..5}", () => {
  const shelves: CompetitorAngle[][] = [
    [],
    [makeAngle(null, null)],
    [makeAngle("tired", null)],
    [makeAngle("clean energy", null)],
    [makeAngle("adaptogen", null)],
    [makeAngle("vs coffee", null)],
  ];
  const valid: readonly SchwartzLevel[] = [1, 2, 3, 4, 5];
  for (const shelf of shelves) {
    const level = computeSophisticationLevel(shelf);
    assert.ok(valid.includes(level), `expected SchwartzLevel in {1..5}, got ${level}`);
  }
});

test("computeSophisticationLevel: null hook + null mechanismClaim → treated as L1 unaware", () => {
  const shelf = [makeAngle(null, null), makeAngle(null, null)];
  assert.equal(computeSophisticationLevel(shelf), 1);
});
