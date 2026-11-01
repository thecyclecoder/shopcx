/**
 * Engine known-reseller matching tests.
 *
 * Incident: 10083 Lynden Oval (Cleveland-area reseller, PII scrubbed — business
 * name, seller id, and buyer are stand-ins). The reseller's registered address
 * is "10083 Lynden Oval"; orders arrived written as "010083 Lynden Ova.l, Apt1"
 * to beat exact matching. The normalize fast path cannot see through the
 * injected dot, so the zip + street-number prefilter must send the pair to the
 * model, and a MATCH answer must flag it.
 *
 * Parity: `normalizeReseller` / `parseAddressLines` against the legacy module,
 * and the address-match prompt against the template in fraud-detector.ts
 * (byte-identical, so the Phase 2 shadow can replay legacy Haiku answers).
 *
 * Run: npx tsx --test src/lib/engine/fraud/reseller.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import {
  normalizeReseller,
  parseAddressLines,
  buildAddressMatchPrompt,
  formatAddressForMatch,
  parseAddressMatchAnswer,
  classifyResellerCandidate,
  prefilterResellerCandidates,
  matchKnownResellers,
  resellerCaseTitle,
  type KnownReseller,
  type AddressLite,
} from "./index";
import {
  normalizeReseller as legacyNormalizeReseller,
  parseAddressLines as legacyParseAddressLines,
} from "../../known-resellers";

const lynden = (over: Partial<KnownReseller> = {}): KnownReseller => ({
  id: "r-lynden",
  business_name: "Example Resale LLC",
  address1: "10083 Lynden Oval",
  address2: "Apt 100",
  city: "Cleveland",
  state: "OH",
  zip: "44130",
  normalized_address: normalizeReseller({ address1: "10083 Lynden Oval", zip: "44130" }),
  amazon_seller_id: "AEXAMPLE123",
  ...over,
});

const other: KnownReseller = {
  id: "r-other", business_name: null, address1: "500 Market St", address2: null, city: "Akron", state: "OH",
  zip: "44308", normalized_address: "500 market st|44308", amazon_seller_id: "AOTHER456",
};

test("normalizeReseller + parseAddressLines match legacy byte-for-byte", () => {
  const addrs = [
    { address1: "10083 Lynden Oval", zip: "44130-1234" },
    { address1: "010083 Lynden Ova.l", zip: "44130" },
    { address1: "7704 Romaine Street, Suite 2", zip: "90046" },
    { address1: "12 Avenue Dr. Apartment #4", zip: null },
    { address1: null, zip: "1" },
    {},
  ];
  for (const a of addrs) assert.equal(normalizeReseller(a), legacyNormalizeReseller(a), JSON.stringify(a));
  assert.equal(normalizeReseller({ address1: "10083 Lynden Oval", zip: "44130" }), "10083 lynden ovl|44130");

  const blocks = [
    ["10083 Lynden Oval", "Apt 100", "Cleveland", "OH", "44130-1234", "US"],
    ["500 Market St", "Akron", "Ohio", "44308", "United States"],
    ["1 Rue X", "Paris", "IDF", "75001", "FR"],
    ["  ", ""],
    ["Only Street"],
  ];
  for (const b of blocks) assert.deepEqual(parseAddressLines(b), legacyParseAddressLines(b), JSON.stringify(b));
});

test("address-match prompt is byte-identical to the legacy fraud-detector.ts template", () => {
  const src = readFileSync(join(__dirname, "..", "..", "fraud-detector.ts"), "utf8");
  const start = src.indexOf("const prompt = `You are detecting");
  assert.ok(start > 0, "legacy prompt not found — did haikuAddressesMatch move?");
  const bodyStart = src.indexOf("`", start) + 1;
  const bodyEnd = src.indexOf("`;", bodyStart);
  const template = src.slice(bodyStart, bodyEnd);
  // The legacy template interpolates only fmt(a) / fmt(b), with this exact fmt.
  assert.ok(src.includes('[x.address1, x.address2, x.city, x.state || x.province, x.zip].filter(Boolean).join(", ")'));
  assert.deepEqual(template.match(/\$\{[^}]*\}/g), ["${fmt(a)}", "${fmt(b)}"]);
  assert.ok(!template.includes("\\"), "template has escapes; plain substitution would be wrong");

  const a: AddressLite = { address1: "010083 Lynden Ova.l", address2: "Apt1", city: "Cleveland", province: "Ohio", zip: "44130" };
  const b: AddressLite = { address1: "10083 Lynden Oval", address2: "Apt 100", city: "Cleveland", state: "OH", zip: "44130" };
  const legacy = template.replace("${fmt(a)}", formatAddressForMatch(a)).replace("${fmt(b)}", formatAddressForMatch(b));
  assert.equal(buildAddressMatchPrompt(a, b), legacy);
  assert.ok(legacy.includes("Address A (incoming order): 010083 Lynden Ova.l, Apt1, Cleveland, Ohio, 44130\n"));
  assert.ok(legacy.includes("Address B (known reseller):  10083 Lynden Oval, Apt 100, Cleveland, OH, 44130\n"));
});

test("answer parser: starts-with MATCH, case-insensitive; everything else is DIFFERENT", () => {
  assert.equal(parseAddressMatchAnswer("MATCH"), true);
  assert.equal(parseAddressMatchAnswer("  match."), true);
  assert.equal(parseAddressMatchAnswer("MATCHES"), true);
  assert.equal(parseAddressMatchAnswer("DIFFERENT"), false);
  assert.equal(parseAddressMatchAnswer("NO MATCH"), false);
  assert.equal(parseAddressMatchAnswer(""), false);
  assert.equal(parseAddressMatchAnswer(null), false);
});

test("10083 Lynden Oval obfuscation: exact path misses, prefilter asks the model, MATCH flags it", async () => {
  const order = {
    shipping_address: { first_name: "Sam", last_name: "Buyer", address1: "010083 Lynden Ova.l", address2: "Apt1", city: "Cleveland", province: "Ohio", zip: "44130" },
    billing_address: null,
  };
  const r = lynden();
  assert.equal(classifyResellerCandidate(order.shipping_address, r), "ask");
  assert.equal(classifyResellerCandidate(order.shipping_address, other), "skip");

  const pre = prefilterResellerCandidates(order, [r, other]);
  assert.equal(pre.exact.length, 0);
  assert.deepEqual(pre.ask.map((x) => [x.reseller.id, x.side]), [["r-lynden", "shipping"]]);

  const prompts: string[] = [];
  const hits = await matchKnownResellers(order, [r, other], async (p) => { prompts.push(p); return "MATCH"; });
  assert.equal(prompts.length, 1);
  // The reseller side is rebuilt from the row without province, exactly like legacy.
  assert.equal(prompts[0], buildAddressMatchPrompt(order.shipping_address, {
    address1: r.address1, address2: r.address2, city: r.city, state: r.state, zip: r.zip,
  }));
  assert.deepEqual(hits.map((h) => [h.reseller.id, h.matchedOn, h.method]), [["r-lynden", "shipping", "haiku"]]);
  assert.equal(
    resellerCaseTitle(hits[0], "SC300001", "5550001"),
    "Amazon reseller address match: Example Resale LLC on order SC300001",
  );

  // Model says DIFFERENT, or the call fails → no hit (legacy catch → false).
  assert.deepEqual(await matchKnownResellers(order, [r], async () => "DIFFERENT"), []);
  assert.deepEqual(await matchKnownResellers(order, [r], async () => { throw new Error("529"); }), []);
});

test("10083 Lynden Oval written plainly: exact fast path on both sides, deduped to one hit, no model call", async () => {
  const plain = { address1: "10083 Lynden Oval.", address2: "Apt 100", city: "Cleveland", zip: "44130-0001" };
  const order = { shipping_address: plain, billing_address: plain };
  let calls = 0;
  const hits = await matchKnownResellers(order, [lynden({ business_name: null })], async () => { calls++; return "MATCH"; });
  assert.equal(calls, 0);
  assert.deepEqual(hits.map((h) => [h.reseller.id, h.matchedOn, h.method]), [["r-lynden", "shipping", "exact"]]);
  // business_name null → title falls back to the seller id, like legacy.
  assert.equal(resellerCaseTitle(hits[0], null, "5550002"), "Amazon reseller address match: AEXAMPLE123 on order 5550002");
});

test("prefilter: different street number or zip never reaches the model", () => {
  const r = lynden();
  assert.equal(classifyResellerCandidate({ address1: "10084 Lynden Oval", zip: "44130" }, r), "skip");
  assert.equal(classifyResellerCandidate({ address1: "10083 Lynden Oval", zip: "44131" }, r), "skip");
  assert.equal(classifyResellerCandidate({ address1: "Lynden Oval", zip: "44130" }, r), "skip");
  assert.equal(classifyResellerCandidate({ address1: "0010083 Lynden Ovl #9", zip: "44130" }, r), "ask");
});
