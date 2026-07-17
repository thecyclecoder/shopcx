/**
 * Pins `canonicalizeEmail` — Gmail dot-and-plus-insensitive canonicalizer.
 *
 * Wedge: ticket 54f0f29e (Julie Metz) — support email `metz.julie323@gmail.com`
 * spawned an empty shadow of the real record `metzjulie323@gmail.com` because
 * inbound-email ingest looked up by exact string. Two gmail addresses that
 * differ only in dots (or a +tag, or googlemail.com vs gmail.com) resolve to
 * the same real inbox and MUST canonicalize equal.
 *
 * Non-gmail providers treat dots as significant, so the helper must NOT
 * touch dots outside Gmail — that would fuse distinct inboxes.
 *
 * Run: npx tsx --test src/lib/email-utils.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeEmail } from "./email-utils";

test("gmail dot-variant collapses to the same canonical (the Julie Metz wedge)", () => {
  assert.equal(canonicalizeEmail("metz.julie323@gmail.com"), "metzjulie323@gmail.com");
  assert.equal(canonicalizeEmail("metzjulie323@gmail.com"), "metzjulie323@gmail.com");
  assert.equal(
    canonicalizeEmail("metz.julie323@gmail.com"),
    canonicalizeEmail("metzjulie323@gmail.com"),
  );
});

test("gmail multiple dots + mixed case + surrounding whitespace all collapse", () => {
  assert.equal(canonicalizeEmail("  J.O.H.N.Doe@Gmail.com  "), "johndoe@gmail.com");
});

test("gmail +tag is dropped from the local part", () => {
  assert.equal(canonicalizeEmail("julie+shopcx@gmail.com"), "julie@gmail.com");
  assert.equal(canonicalizeEmail("metz.julie323+alerts@gmail.com"), "metzjulie323@gmail.com");
});

test("googlemail.com is normalized to gmail.com and shares the same canonical", () => {
  assert.equal(canonicalizeEmail("metz.julie323@googlemail.com"), "metzjulie323@gmail.com");
  assert.equal(
    canonicalizeEmail("metz.julie323@googlemail.com"),
    canonicalizeEmail("metzjulie323@gmail.com"),
  );
});

test("non-gmail providers PRESERVE dots (dots are significant elsewhere)", () => {
  assert.equal(canonicalizeEmail("first.last@fastmail.com"), "first.last@fastmail.com");
  assert.equal(canonicalizeEmail("first.last@outlook.com"), "first.last@outlook.com");
  assert.equal(canonicalizeEmail("first.last@proton.me"), "first.last@proton.me");
  // Same-local, different-provider dot variants remain distinct.
  assert.notEqual(
    canonicalizeEmail("first.last@fastmail.com"),
    canonicalizeEmail("firstlast@fastmail.com"),
  );
});

test("non-gmail +tag is preserved (some providers use +tag for routing, but tag semantics vary)", () => {
  // We only strip +tag for gmail where the semantics are documented.
  assert.equal(canonicalizeEmail("julie+shopcx@fastmail.com"), "julie+shopcx@fastmail.com");
});

test("mixed case + whitespace always trims/lowercases regardless of provider", () => {
  assert.equal(canonicalizeEmail("  Julie@Fastmail.COM  "), "julie@fastmail.com");
  assert.equal(canonicalizeEmail("JULIE@GMAIL.COM"), "julie@gmail.com");
});

test("malformed input returns trimmed+lowered without throwing", () => {
  assert.equal(canonicalizeEmail(""), "");
  assert.equal(canonicalizeEmail("   "), "");
  assert.equal(canonicalizeEmail("not-an-email"), "not-an-email");
  assert.equal(canonicalizeEmail("@gmail.com"), "@gmail.com");
  assert.equal(canonicalizeEmail("julie@"), "julie@");
  // Only the LAST @ splits the address — Gmail semantics apply to the domain.
  assert.equal(canonicalizeEmail("weird@name@gmail.com"), "weird@name@gmail.com");
});

test("idempotent: canonicalize(canonicalize(x)) === canonicalize(x)", () => {
  const inputs = [
    "metz.julie323@gmail.com",
    "julie+tag@gmail.com",
    "metz.julie@googlemail.com",
    "first.last@fastmail.com",
    "  Mixed.Case+tag@Gmail.com  ",
    "",
    "not-an-email",
  ];
  for (const raw of inputs) {
    const once = canonicalizeEmail(raw);
    assert.equal(canonicalizeEmail(once), once, `not idempotent for ${JSON.stringify(raw)}`);
  }
});
