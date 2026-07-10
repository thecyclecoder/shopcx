/**
 * Regression pins for country-iso2 normalization, grounded in Evan H.'s
 * SC132221 replacement: his address stored `country: "United States"`
 * with no `country_code`, and the resolver upstream produced "UN" —
 * which the LENIENT normalizer trusted verbatim (matches /^[A-Z]{2}$/),
 * shipping "UN" to Shopify and stranding the replacement at
 * address_confirmed for 17 days.
 *
 * Run: npx tsx --test src/lib/country-iso2.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCountryToIso2, normalizeCountryToIso2Strict } from "./country-iso2";

// ── Lenient variant — always returns a valid Shopify countryCode. ──

test("full-name country → ISO-2 (the SC132221 case: 'United States' → 'US', not 'UN')", () => {
  assert.equal(normalizeCountryToIso2("United States"), "US");
  assert.equal(normalizeCountryToIso2("united states"), "US");
  assert.equal(normalizeCountryToIso2("Canada"), "CA");
  assert.equal(normalizeCountryToIso2("United Kingdom"), "GB");
});

test("lowercase 2-letter code → uppercased ('us' → 'US')", () => {
  assert.equal(normalizeCountryToIso2("us"), "US");
  assert.equal(normalizeCountryToIso2("ca"), "CA");
  assert.equal(normalizeCountryToIso2("gb"), "GB");
});

test("empty / null / whitespace → store default 'US' (never yields the empty string that would blow up Shopify)", () => {
  assert.equal(normalizeCountryToIso2(""), "US");
  assert.equal(normalizeCountryToIso2(null), "US");
  assert.equal(normalizeCountryToIso2(undefined), "US");
  assert.equal(normalizeCountryToIso2("   "), "US");
});

test("'UN' — the exact 2-letter code that stranded SC132221 — is NEVER trusted verbatim (falls back to 'US', never yields 'UN')", () => {
  assert.notEqual(normalizeCountryToIso2("UN"), "UN");
  assert.equal(normalizeCountryToIso2("UN"), "US");
});

test("Shopify US-territory convention (PR/GU/VI/AS/MP) folds to 'US'", () => {
  assert.equal(normalizeCountryToIso2("PR"), "US");
  assert.equal(normalizeCountryToIso2("GU"), "US");
  assert.equal(normalizeCountryToIso2("VI"), "US");
  assert.equal(normalizeCountryToIso2("AS"), "US");
  assert.equal(normalizeCountryToIso2("MP"), "US");
});

test("known ISO-2 codes for common shipping destinations pass through", () => {
  assert.equal(normalizeCountryToIso2("US"), "US");
  assert.equal(normalizeCountryToIso2("CA"), "CA");
  assert.equal(normalizeCountryToIso2("AU"), "AU");
  assert.equal(normalizeCountryToIso2("GB"), "GB");
  assert.equal(normalizeCountryToIso2("MX"), "MX");
  assert.equal(normalizeCountryToIso2("DE"), "DE");
});

// ── Strict variant — for callers that must fail loudly on unresolvable input. ──

test("strict: unrecognized 2-letter code returns null ('UN' → null, not the silently-trusted 'UN')", () => {
  assert.equal(normalizeCountryToIso2Strict("UN"), null);
  // A non-country region code like "EU" — reject unless we've explicitly added it.
  assert.equal(normalizeCountryToIso2Strict("EU"), null);
  // Junk 2-letter that isn't a country.
  assert.equal(normalizeCountryToIso2Strict("XX"), null);
});

test("strict: empty / null / whitespace returns null (caller decides whether to fall back to a store default)", () => {
  assert.equal(normalizeCountryToIso2Strict(""), null);
  assert.equal(normalizeCountryToIso2Strict(null), null);
  assert.equal(normalizeCountryToIso2Strict(undefined), null);
  assert.equal(normalizeCountryToIso2Strict("   "), null);
});

test("strict: full-name country still resolves ('United States' → 'US')", () => {
  assert.equal(normalizeCountryToIso2Strict("United States"), "US");
  assert.equal(normalizeCountryToIso2Strict("Canada"), "CA");
});

test("strict: known ISO-2 code passes through", () => {
  assert.equal(normalizeCountryToIso2Strict("US"), "US");
  assert.equal(normalizeCountryToIso2Strict("CA"), "CA");
  assert.equal(normalizeCountryToIso2Strict("gb"), "GB");
});

test("strict: unknown full name is rejected (no silent default)", () => {
  assert.equal(normalizeCountryToIso2Strict("Middle-Earth"), null);
  assert.equal(normalizeCountryToIso2Strict("Not A Country"), null);
});
