/**
 * Phase 2 regression — Appstle's `replace-variants-v3` returns 200 on
 * requests it silently declines to apply. `classifyReplaceVariantsBody` must
 * treat those bodies as FAILURES, not success, and MUST tag `errorKey:
 * maxiterations` as `permanent: true` so the caller surfaces it for human
 * repair instead of retrying into the same upstream wall.
 *
 * Grounded in contracts 27946909869 + 27871477933 (2026-07-30) — two
 * subscriptions told to swap flavour, told success, and never moved. Spec:
 *   docs/brain/specs/a-subscription-mutation-must-verify-it-happened-not-trust-http-200.md
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.replaceVariantsDecline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyReplaceVariantsBody } from "./subscription-items";

test("2xx with a normal body (no decline shape) → applied, not declined", () => {
  // The happy path: Appstle returns 200 with the updated contract JSON. No
  // errorKey, no `success: false`, no `errors[]`.
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    id: 123,
    lines: { nodes: [{ variantId: "gid://shopify/ProductVariant/NEW-999", quantity: 1 }] },
  }));
  assert.equal(result.declined, false);
  assert.equal(result.permanent, false);
});

test("2xx-with-decline body carrying errorKey=maxiterations → declined AND permanent", () => {
  // The exact 2026-07-30 shape on contracts 27946909869 / 27871477933.
  // A 200 status is NOT proof the mutation applied when the body says so.
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    errorKey: "maxiterations",
    errorMessage: "Unable to complete variant replacement after multiple attempts",
  }));
  assert.equal(result.declined, true, "must classify a 2xx-with-decline as declined, not success");
  assert.equal(result.permanent, true, "maxiterations survived every retry — permanent for the contract");
  assert.equal(result.errorKey, "maxiterations");
  assert.match(result.reason!, /maxiterations/);
});

test("non-2xx with errorKey=maxiterations body → declined AND permanent", () => {
  // maxiterations shows up in both 200-with-decline and 4xx bodies — either
  // way it is permanent for that contract and must not be retried blindly.
  const result = classifyReplaceVariantsBody(422, JSON.stringify({
    errorKey: "maxiterations",
    errorMessage: "Unable to complete variant replacement after multiple attempts",
  }));
  assert.equal(result.declined, true);
  assert.equal(result.permanent, true);
  assert.equal(result.errorKey, "maxiterations");
});

test("2xx with a non-maxiterations errorKey → declined, NOT permanent", () => {
  // A different Appstle errorKey is still a decline (the mutation did not
  // land), but is NOT classified permanent — the caller may retry.
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    errorKey: "validation_error",
    errorMessage: "Variant not eligible",
  }));
  assert.equal(result.declined, true);
  assert.equal(result.permanent, false);
  assert.equal(result.errorKey, "validation_error");
});

test("2xx with explicit success:false in body → declined, NOT permanent", () => {
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    success: false,
    message: "Contract locked",
  }));
  assert.equal(result.declined, true);
  assert.equal(result.permanent, false);
});

test("2xx with errors:[…] array → declined, NOT permanent", () => {
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    errors: [{ field: "newVariants", message: "must be non-empty" }],
  }));
  assert.equal(result.declined, true);
  assert.equal(result.permanent, false);
});

test("non-2xx with an unstructured body → declined, NOT permanent", () => {
  // A 500 with a bare text body is a transient upstream failure, not a
  // permanent per-contract wall — the caller retries.
  const result = classifyReplaceVariantsBody(500, "Internal Server Error");
  assert.equal(result.declined, true);
  assert.equal(result.permanent, false);
});

test("raw text mentioning 'maxiterations' outside JSON → declined AND permanent (defensive fallback)", () => {
  // Belt-and-braces: if Appstle ever ships an unparseable body that still
  // names the class, the classifier catches it rather than treating an
  // unstructured mention as success.
  const result = classifyReplaceVariantsBody(200, "internal error: maxiterations reached");
  assert.equal(result.declined, true);
  assert.equal(result.permanent, true);
});

test("2xx with empty body → applied (no decline signal to detect)", () => {
  const result = classifyReplaceVariantsBody(200, "");
  assert.equal(result.declined, false);
  assert.equal(result.permanent, false);
});

test("2xx with nested error.errorKey shape → declined AND permanent when maxiterations", () => {
  // Spring-Boot-style error envelopes occasionally nest the key under `error`.
  const result = classifyReplaceVariantsBody(200, JSON.stringify({
    success: true,
    error: { errorKey: "maxiterations", message: "Unable to complete variant replacement" },
  }));
  assert.equal(result.declined, true);
  assert.equal(result.permanent, true);
  assert.equal(result.errorKey, "maxiterations");
});
