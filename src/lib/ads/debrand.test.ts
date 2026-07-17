/**
 * debrand tests — pin the Phase 1 rules of
 * [[../../../docs/brain/specs/dahlia-preserve-competitor-copy-dna-debranded.md]]:
 *   npx tsx --test src/lib/ads/debrand.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { debrandForOurBrand } from "./debrand";

test("(a) 'MUD/WTR vs Ryze' with competitorAdvertiser='MUD/WTR' → 'vs Ryze' (brand slash-name stripped)", () => {
  assert.equal(
    debrandForOurBrand("MUD/WTR vs Ryze", "MUD/WTR", "Superfoods Company"),
    "vs Ryze",
  );
});

test("(b) 'Ryze Mushroom Coffee is better' with competitorAdvertiser='Ryze' → 'Mushroom Coffee is better' ('coffee' allowlist keeps the benign token untouched — only present in text, but the advertiser tokens themselves are also allowlisted so a 'Ryze Coffee' advertiser wouldn't over-strip)", () => {
  assert.equal(
    debrandForOurBrand("Ryze Mushroom Coffee is better", "Ryze", "Superfoods Company"),
    "Mushroom Coffee is better",
  );
});

test("(c) null competitorAdvertiser → input unchanged", () => {
  assert.equal(
    debrandForOurBrand("Ryze Mushroom Coffee is better", null, "Superfoods Company"),
    "Ryze Mushroom Coffee is better",
  );
});

test("(d) case-insensitivity: lower-case 'ryze' in text is stripped when advertiser is 'Ryze'", () => {
  assert.equal(
    debrandForOurBrand("ryze mushroom coffee is better", "Ryze", "Superfoods Company"),
    "mushroom coffee is better",
  );
});

test("(e) empty text is returned unchanged (null-safe)", () => {
  assert.equal(debrandForOurBrand("", "Ryze", "Superfoods Company"), "");
});

test("(f) product-name allowlist prevents over-strip: advertiser 'Ryze Coffee' does not strip 'coffee' from the text — only 'Ryze' is stripped", () => {
  assert.equal(
    debrandForOurBrand("Ryze Coffee is smoother than the rest", "Ryze Coffee", "Superfoods Company"),
    "Coffee is smoother than the rest",
  );
});

test("(g) possessive suffix on a stripped token is also removed ('Ryze's mushroom blend' → 'mushroom blend')", () => {
  assert.equal(
    debrandForOurBrand("Ryze's mushroom blend", "Ryze", "Superfoods Company"),
    "mushroom blend",
  );
});

test("(h) whole-word boundary — advertiser 'RYZ' does NOT strip 'ryzen' (would be a partial hit)", () => {
  assert.equal(
    debrandForOurBrand("The ryzen platform is fast", "RYZ", "Superfoods Company"),
    "The ryzen platform is fast",
  );
});

test("(i) tokens shorter than 3 chars in advertiser are ignored (a 2-char 'IO' would risk stripping IO from IO-Zen; only ≥3-char tokens participate)", () => {
  assert.equal(
    debrandForOurBrand("IO-Zen is a great blend", "IO Zen", "Superfoods Company"),
    "IO- is a great blend",
  );
});
