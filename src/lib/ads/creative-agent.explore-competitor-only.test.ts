/**
 * partitionExplorePool tests — pin the CEO 2026-08-31 rail:
 *   "Dahlia should never make an ad for discover (not exploit) if she doesn't have a competitor
 *    pin — she shouldn't just freestyle a discover ad."
 *
 *   npm run test:creative-agent-explore-competitor-only
 *
 * The regression this locks: before the rail, `explorePool` was every unproven angle sorted
 * competitor-first, so own-brand angles merely ranked behind competitor ones and silently filled
 * the slots whenever the competitor pool ran dry. With the cold temperature filter cutting 40
 * shared K-Cups angles down to 1, that made 10 of 11 K-Cups explores and 12 of 18 Superfood Tabs
 * explores freestyled own-brand ads carrying `provenance.competitor_hook = null` — including the
 * 2026-08-26 K-Cups weight-loss ad (campaign 3743b942).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { partitionExplorePool } from "./creative-agent";

const competitor = (hook: string) => ({ source: "competitor" as const, hook });
const ownBrand = (hook: string, source: "review_cluster" | "transformation" | "authority" = "review_cluster") =>
  ({ source, hook });

test("an own-brand angle is NEVER explore-eligible, however good it looks", () => {
  const { explorable, withheld } = partitionExplorePool([
    ownBrand("lost roughly 50 pounds in 18 months", "transformation"),
    ownBrand("formulated with nutritionists", "authority"),
  ]);
  assert.deepEqual(explorable, [], "no competitor angle ⇒ nothing to explore with");
  assert.equal(withheld.length, 2, "both own-brand angles are withheld, not silently used");
});

test("competitor angles are explore-eligible", () => {
  const { explorable, withheld } = partitionExplorePool([competitor("Most coffee is contaminated.")]);
  assert.equal(explorable.length, 1);
  assert.deepEqual(withheld, []);
});

test("a mixed pool keeps ONLY the competitor angles and reports the rest", () => {
  const { explorable, withheld } = partitionExplorePool([
    ownBrand("gentle on the stomach"),
    competitor("Most coffee is contaminated."),
    ownBrand("sharper focus and mental clarity"),
    competitor("Your morning cup is making you tired."),
  ]);
  assert.equal(explorable.length, 2);
  assert.ok(explorable.every((a) => a.source === "competitor"));
  assert.equal(withheld.length, 2, "withheld is reported so a starved shelf is visible, not silent");
});

test("an empty pool yields empty halves — the correct output is NO AD, not a fallback", () => {
  const { explorable, withheld } = partitionExplorePool([]);
  assert.deepEqual(explorable, []);
  assert.deepEqual(withheld, []);
});

test("order is preserved within each half so the caller's ranking still applies", () => {
  const { explorable } = partitionExplorePool([
    competitor("first"), ownBrand("skipped"), competitor("second"), competitor("third"),
  ]);
  assert.deepEqual(explorable.map((a) => a.hook), ["first", "second", "third"]);
});

test("the K-Cups shape: 1 surviving competitor angle + many own-brand ⇒ exactly 1 explorable", () => {
  // The real 2026-08-31 pool for Amazing Coffee K-Cups: the cold filter left ONE competitor angle,
  // and own-brand review-cluster angles backfilled the rest. Post-rail, capacity is 1 — not 11.
  const pool = [
    competitor("Most coffee is contaminated. Yep! even your favourite one."),
    ...["curbs appetite", "sharper focus", "gentle on the stomach", "weight loss"].map((h) => ownBrand(h)),
  ];
  const { explorable, withheld } = partitionExplorePool(pool);
  assert.equal(explorable.length, 1, "capacity is the competitor shelf, not the own-brand shelf");
  assert.equal(withheld.length, 4);
});
