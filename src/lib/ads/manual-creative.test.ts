/**
 * Unit tests for `evaluateManualCreativeGate` — the pure pre-write rail on
 * [[./manual-creative]] `landManualCreative`.
 *
 * The gate is the reason this SDK exists instead of a raw `.from("ad_campaigns").insert()`:
 * a hand-produced creative must not land as a row that would publish DEGRADED. Every
 * refusal below maps to a concrete downstream failure:
 *   - <4 headlines / primary texts → Meta ships a single-copy ad (CREATIVE_PACK_MIN)
 *   - over a META_CAP           → Graph rejects at creative-create
 *   - no ?angle=&variant=       → the attribution sensor buckets clicks to (unresolved)
 *                                 and per-creative ROAS goes dark
 *   - empty media               → a 'ready' row pointing at nothing
 *   - self-score under floor    → below the bar Dahlia's own author loop enforces
 *
 * Pure function, no Supabase — the writer half is exercised against the live DB by the
 * landing script, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateManualCreativeGate, type LandManualCreativeArgs } from "@/lib/ads/manual-creative";
import { META_CAPS } from "@/lib/ad-tool-config";
import { AUTHOR_SELF_SCORE_FLOOR } from "@/lib/ads/creative-agent";

const FOUR = ["one", "two", "three", "four"];

function args(over: Partial<LandManualCreativeArgs> = {}): LandManualCreativeArgs {
  return {
    workspaceId: "11111111-1111-1111-1111-111111111111",
    productId: "22222222-2222-2222-2222-222222222222",
    name: "Podcast interview — Creatine Prime+",
    landingUrl: "https://example.com/p/creatine?angle=aging&variant=advertorial",
    audienceTemperature: "cold",
    copyPack: { headlines: [...FOUR], primaryTexts: [...FOUR], description: "5g creatine + rhodiola" },
    selfScore: null,
    media: { buffer: Buffer.from("mp4-bytes"), format: "reels_9x16", durationSec: 56 },
    ...over,
  };
}

test("accepts a complete pack with a scent-matched URL", () => {
  assert.deepEqual(evaluateManualCreativeGate(args()), { ok: true });
});

test("refuses a pack below the 4-headline minimum", () => {
  const r = evaluateManualCreativeGate(args({ copyPack: { headlines: ["a", "b"], primaryTexts: [...FOUR], description: "d" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "headlines_below_min");
});

test("refuses a pack below the 4-primary-text minimum", () => {
  const r = evaluateManualCreativeGate(args({ copyPack: { headlines: [...FOUR], primaryTexts: ["a"], description: "d" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "primary_texts_below_min");
});

test("refuses a headline over META_CAPS.headline", () => {
  const tooLong = "x".repeat(META_CAPS.headline + 1);
  const r = evaluateManualCreativeGate(args({ copyPack: { headlines: [tooLong, "b", "c", "d"], primaryTexts: [...FOUR], description: "d" } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "headline_over_cap");
});

test("refuses a description over META_CAPS.description", () => {
  const r = evaluateManualCreativeGate(args({ copyPack: { headlines: [...FOUR], primaryTexts: [...FOUR], description: "x".repeat(META_CAPS.description + 1) } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "description_over_cap");
});

test("refuses a destination URL missing the scent-match params", () => {
  for (const url of ["https://example.com/p/creatine", "https://example.com/p/creatine?angle=aging", "not-a-url", ""]) {
    const r = evaluateManualCreativeGate(args({ landingUrl: url }));
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(url)}`);
    assert.equal(r.reason, "missing_scent_match_params");
  }
});

test("refuses empty media bytes", () => {
  const r = evaluateManualCreativeGate(args({ media: { buffer: Buffer.alloc(0), format: "reels_9x16", durationSec: 56 } }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "empty_media");
});

test("refuses a self-score below the author floor, accepts at the floor", () => {
  const score = (total: number) => ({ lf8: 2, schwartz: 2, cialdini: 2, hopkins: 2, sugarman: 2, total, evidence: [] });
  const under = evaluateManualCreativeGate(args({ selfScore: score(AUTHOR_SELF_SCORE_FLOOR - 1) }));
  assert.equal(under.ok, false);
  assert.equal(under.reason, "self_score_below_floor");
  assert.equal(evaluateManualCreativeGate(args({ selfScore: score(AUTHOR_SELF_SCORE_FLOOR) })).ok, true);
});

test("a null self-score skips the floor check (deliberately unscored creative still lands)", () => {
  assert.equal(evaluateManualCreativeGate(args({ selfScore: null })).ok, true);
});
