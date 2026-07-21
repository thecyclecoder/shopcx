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
import { hasAnyLf8, LF8_KEYWORDS, hasColdOfferLeak } from "./lf8";

// ── hasColdOfferLeak — word-boundary, not substring (2026-07-17 "coffee" regression) ─────────────
const c = (headline: string, primaryText = "", description = "") => ({ headline, primaryText, description });

test("hasColdOfferLeak: clean cold COFFEE copy is NOT a leak (the 'off' inside 'coffee' bug)", () => {
  assert.equal(hasColdOfferLeak(c("Your afternoon crash, solved", "500+ million cups of Amazing Coffee sold.", "Superfood coffee for steady energy.")), false);
  // other word-boundary false positives the old substring match hit
  assert.equal(hasColdOfferLeak(c("The ideal morning ritual")), false); // "ideal" contains "deal"
  assert.equal(hasColdOfferLeak(c("An unsaved draft")), false); // "unsaved" contains "save"
  assert.equal(hasColdOfferLeak(c("todays focus formula")), false); // "todays" contains "today"
});

test("hasColdOfferLeak: a trust / risk-reversal element is ALLOWED on cold (CEO 2026-07-21 — swap the offer slot, don't kill the ad)", () => {
  // When imitating an offer-led ad on cold, the offer slot is swapped for one of these — they reduce
  // purchase risk without training a cold viewer to chase deals, so they must NOT trip the gate.
  assert.equal(hasColdOfferLeak(c("Free shipping on every order")), false); // trust, not a deal-chase
  assert.equal(hasColdOfferLeak(c("Backed by a 30-day money-back guarantee")), false);
  assert.equal(hasColdOfferLeak(c("Try it risk-free")), false);
  assert.equal(hasColdOfferLeak(c("Third-party tested, trusted by 700K+ customers")), false);
  // …but a genuine discount in the same slot STILL trips:
  assert.equal(hasColdOfferLeak(c("Free shipping AND 20% off")), true); // the "off" discount still leaks
});

test("hasColdOfferLeak: a benefit / social-proof STAT is allowed (not a discount)", () => {
  assert.equal(hasColdOfferLeak(c("Feel 40% more focused by week two")), false);
  assert.equal(hasColdOfferLeak(c("95% of drinkers report steadier energy")), false);
});

test("hasColdOfferLeak: a real DISCOUNT / offer is caught", () => {
  assert.equal(hasColdOfferLeak(c("50% off today only")), true); // off + today
  assert.equal(hasColdOfferLeak(c("Save $10 on your first bag")), true); // save
  assert.equal(hasColdOfferLeak(c("Get 20% discount")), true); // % discount
  assert.equal(hasColdOfferLeak(c("Just $29 a bag")), true); // bare currency (a price shown to cold)
  assert.equal(hasColdOfferLeak(c("Grab this deal")), true);
});

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
    ["save", "off", "deal", "today"].some((kw) => LF8_KEYWORDS.includes(kw)),
    "expected LF8_KEYWORDS to include at least one offer/urgency term",
  );
  // free shipping is NO LONGER an offer/urgency token (CEO 2026-07-21 — it's a cold-allowed trust element)
  assert.ok(!LF8_KEYWORDS.includes("free shipping"), "free shipping was removed from the offer/urgency cluster");
});
