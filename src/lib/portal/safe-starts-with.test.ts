/**
 * Regression tests for safeStartsWith — the typeof-guarded String.prototype.startsWith
 * used on values that originate from portal request input (body fields, query, URL).
 *
 * The prod signature was `[portal] route error: t.startsWith is not a function`
 * (vercel:a08795a29d9404a4): a body field the client sent as a number/object/null
 * flowed into `.startsWith` and crashed the request, which the outer /api/portal
 * catch mislabeled as 401 Unauthorized. This helper turns every such non-string
 * shape into a plain `false` — no throw, no 500, no misleading log line — so the
 * handler's downstream branch reads it as "not a match" and continues cleanly.
 *
 * Run:
 *   npx tsx --test src/lib/portal/safe-starts-with.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { safeStartsWith } from "./helpers";

test("string that matches the prefix → true", () => {
  assert.equal(safeStartsWith("LOYALTY-2025-Q1", "LOYALTY-"), true);
  assert.equal(safeStartsWith("gid://shopify/SubscriptionLine/999", "gid://"), true);
  assert.equal(safeStartsWith("/account", "/"), true);
});

test("string that does NOT match the prefix → false (no throw)", () => {
  assert.equal(safeStartsWith("SALE20", "LOYALTY-"), false);
  assert.equal(safeStartsWith("", "LOYALTY-"), false);
  assert.equal(safeStartsWith("bogus", "gid://"), false);
});

test("undefined → false (no throw) — the empty-body / missing-field shape", () => {
  assert.equal(safeStartsWith(undefined, "LOYALTY-"), false);
});

test("null → false (no throw) — the explicit-null shape", () => {
  assert.equal(safeStartsWith(null, "LOYALTY-"), false);
});

test("number → false (no throw) — the prod signature: a body field sent as a JSON number", () => {
  assert.equal(safeStartsWith(42, "LOYALTY-"), false);
  assert.equal(safeStartsWith(0, "LOYALTY-"), false);
  assert.equal(safeStartsWith(Number.NaN, "LOYALTY-"), false);
});

test("boolean → false (no throw)", () => {
  assert.equal(safeStartsWith(true, "LOYALTY-"), false);
  assert.equal(safeStartsWith(false, "LOYALTY-"), false);
});

test("plain object → false (no throw) — a client that sends { discountCode: { code: 'X' } }", () => {
  assert.equal(safeStartsWith({ code: "LOYALTY-X" }, "LOYALTY-"), false);
});

test("array → false (no throw) — a client that sends [ 'LOYALTY-X' ]", () => {
  assert.equal(safeStartsWith(["LOYALTY-X"], "LOYALTY-"), false);
});

test("Object.create(null) → false (no throw) — a prototype-less object shape", () => {
  const o = Object.create(null);
  o.code = "LOYALTY-X";
  assert.equal(safeStartsWith(o, "LOYALTY-"), false);
});

test("does NOT throw on the exact prod shape — `t.startsWith is not a function`", () => {
  // The prod signature was TypeError: t.startsWith is not a function on a
  // minified `t`. Every one of these would have thrown against a raw .startsWith;
  // the helper turns each into a clean false.
  const nonStringInputs: unknown[] = [
    undefined,
    null,
    42,
    true,
    { foo: "bar" },
    [1, 2, 3],
    Symbol("s"),
    () => "x",
  ];
  for (const v of nonStringInputs) {
    assert.doesNotThrow(() => safeStartsWith(v, "any-prefix"));
    assert.equal(safeStartsWith(v, "any-prefix"), false);
  }
});
