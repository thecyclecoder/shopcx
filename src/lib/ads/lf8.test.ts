/**
 * lf8 tests — pins that the broadened LF8_KEYWORDS vocabulary (weight-loss/body-transformation,
 * beauty/appearance, immunity/digestion, mood/wellness, offer/urgency) actually catches the
 * four live-ad creatives the ads-supervisor's [[../ads-supervisor]] live_ad_lf8_thin gate
 * false-flagged in a single 3h pass (adsets 120252355815780184 / 120252360719940184 /
 * 120252360719970184 / 120252363256660184). Runs via:
 *   npx tsx --test src/lib/ads/lf8.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hasAnyLf8, LF8_KEYWORDS } from "./lf8";

test("hasAnyLf8: previously false-flagged live creatives now register a hit", () => {
  const previouslyFalseFlagged: readonly string[] = [
    "i lost 40+ pounds! appetite suppression/craving control",
    "i truly believe it is a reason i lost 35 pounds",
    "support skin, hair, and joints while you sip. salted caramel creamer with collagen and clean mct",
    "flash sale - save up to 43%",
  ];
  for (const copy of previouslyFalseFlagged) {
    assert.equal(
      hasAnyLf8(copy),
      true,
      `expected LF8 hit for previously false-flagged creative: ${copy}`,
    );
  }
});

test("LF8_KEYWORDS: contains a weight-loss/body-transformation term", () => {
  const weightLoss = ["weight", "pounds", "lbs", "lost", "slim", "lean", "shed", "appetite", "craving", "transformation", "fit"];
  assert.ok(
    weightLoss.some((kw) => LF8_KEYWORDS.includes(kw)),
    `expected LF8_KEYWORDS to include at least one weight-loss/body-transformation term (${weightLoss.join(", ")})`,
  );
});

test("LF8_KEYWORDS: contains a beauty/appearance term", () => {
  const beauty = ["skin", "hair", "nails", "glow", "collagen", "youthful", "radiant"];
  assert.ok(
    beauty.some((kw) => LF8_KEYWORDS.includes(kw)),
    `expected LF8_KEYWORDS to include at least one beauty/appearance term (${beauty.join(", ")})`,
  );
});

test("LF8_KEYWORDS: contains an immunity/digestion, mood/wellness, and offer/urgency term", () => {
  assert.ok(
    ["immune", "immunity", "gut", "digestion", "bloat", "gut health"].some((kw) => LF8_KEYWORDS.includes(kw)),
    "expected LF8_KEYWORDS to include at least one immunity/digestion term",
  );
  assert.ok(
    ["mood", "happy", "balance", "wellness", "thrive"].some((kw) => LF8_KEYWORDS.includes(kw)),
    "expected LF8_KEYWORDS to include at least one mood/wellness term",
  );
  assert.ok(
    ["save", "off", "free shipping", "deal", "today"].some((kw) => LF8_KEYWORDS.includes(kw)),
    "expected LF8_KEYWORDS to include at least one offer/urgency term",
  );
});
