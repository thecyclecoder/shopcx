/**
 * Unit tests for email-typo — the dependency-free mistyped-email detector/corrector.
 * Built-in node:test — run:  npx tsx --test src/lib/email-typo.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { suggestEmailCorrection, looksMistyped } from "./email-typo";

test("known-good domains are left alone", () => {
  for (const e of ["dylan@gmail.com", "a.b@yahoo.com", "x@icloud.com", "y@outlook.com"]) {
    const s = suggestEmailCorrection(e);
    assert.equal(s.changed, false, e);
    assert.equal(s.confidence, "none");
  }
});

test("single-edit domain typos → high confidence correction", () => {
  const cases: [string, string][] = [
    ["dylanralston@gmaik.com", "dylanralston@gmail.com"],
    ["a@gmial.com", "a@gmail.com"],
    ["a@yahooo.com", "a@yahoo.com"],
    ["a@hotmial.com", "a@hotmail.com"],
    ["a@outlok.com", "a@outlook.com"],
  ];
  for (const [input, want] of cases) {
    const s = suggestEmailCorrection(input);
    assert.equal(s.corrected, want, input);
    assert.equal(s.confidence, "high", input);
    assert.equal(looksMistyped(input), true, input);
  }
});

test("TLD typos are fixed (gmail.con → gmail.com)", () => {
  const s = suggestEmailCorrection("dylan@gmail.con");
  assert.equal(s.corrected, "dylan@gmail.com");
  assert.equal(s.confidence, "high");
  assert.equal(s.reason, "tld_fix");

  const s2 = suggestEmailCorrection("dylan@yahoo.cmo");
  assert.equal(s2.corrected, "dylan@yahoo.com");
});

test("malformed / empty → none", () => {
  for (const e of ["", "no-at-sign", "trailing@", "@leading.com", "spaces only"]) {
    const s = suggestEmailCorrection(e);
    assert.equal(s.changed, false, e);
  }
});

test("normalizes input (trim + lowercase)", () => {
  const s = suggestEmailCorrection("  Dylan@GMAIK.com ");
  assert.equal(s.normalized, "dylan@gmaik.com");
  assert.equal(s.corrected, "dylan@gmail.com");
});

test("legit non-common domains are NOT force-corrected", () => {
  // A real company domain that isn't near a common one stays put.
  for (const e of ["ceo@superfoodscompany.com", "ops@shopcx.ai", "x@somebiz.io"]) {
    const s = suggestEmailCorrection(e);
    assert.equal(s.changed, false, e);
  }
});

test("short SLD near-miss at distance 2 is NOT trusted (avoids false positives)", () => {
  // 'aol.com' is short; a distance-2 neighbor shouldn't auto-suggest.
  const s = suggestEmailCorrection("x@zol.net");
  // Either 'none' or at most 'likely' — must never be 'high' on a short ambiguous SLD.
  assert.notEqual(s.confidence, "high");
});
