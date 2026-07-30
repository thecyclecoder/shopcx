/**
 * Unit tests for the Phase 2 classifier introduced in
 * docs/brain/specs/a-subscription-mutation-must-verify-it-happened-not-trust-http-200.
 *
 * Pins the SPECIFIC false-success shape the spec exists to close: Appstle
 * returns HTTP 200 on `replace-variants-v3` requests it then declines to
 * apply (body carries e.g. `errorKey: maxiterations`), and the caller
 * previously ran on `res.ok` alone — recording the mutation as done while
 * the contract kept the old flavour. `maxiterations` MUST be classified
 * PERMANENT (retrying reaches the same wall — survived every retry across
 * two separate campaigns on 27946909869 + 27871477933 on 2026-07-30);
 * every other 2xx decline shape is transient.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.decline.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyReplaceVariantsBody } from "./subscription-items";

test("named failing state: 200 with errorKey=maxiterations → PERMANENT (the 27946909869 / 27871477933 case)", () => {
  const body = JSON.stringify({
    errorKey: "maxiterations",
    message: "Unable to complete variant replacement after multiple attempts",
  });
  const r = classifyReplaceVariantsBody(body, 200);
  assert.equal(r.kind, "permanent");
  if (r.kind === "permanent") {
    assert.equal(r.errorKey, "maxiterations");
    assert.match(r.reason, /errorKey=maxiterations/);
    assert.match(r.reason, /PERMANENT/);
    assert.match(r.reason, /27946909869|27871477933/);
  }
});

test("200 with an unrecognized errorKey → transient (caller can retry, but the mutation did NOT apply)", () => {
  const body = JSON.stringify({ errorKey: "some_other_error", message: "boom" });
  const r = classifyReplaceVariantsBody(body, 200);
  assert.equal(r.kind, "transient");
  if (r.kind === "transient") {
    assert.equal(r.errorKey, "some_other_error");
    assert.match(r.reason, /errorKey=some_other_error/);
  }
});

test("200 with success:false → transient, not swallowed", () => {
  const body = JSON.stringify({ success: false, message: "nope" });
  const r = classifyReplaceVariantsBody(body, 200);
  assert.equal(r.kind, "transient");
  if (r.kind === "transient") assert.match(r.reason, /success=false/);
});

test("200 with error:'...' → transient, not swallowed", () => {
  const body = JSON.stringify({ error: "something went wrong on the vendor side" });
  const r = classifyReplaceVariantsBody(body, 200);
  assert.equal(r.kind, "transient");
});

test("200 with a plain contract-shaped success body → ok (the historical happy path)", () => {
  const body = JSON.stringify({
    id: "gid://shopify/SubscriptionContract/27946909869",
    lines: { nodes: [{ id: "gid://shopify/SubscriptionLine/1", variantId: "gid://shopify/ProductVariant/44112233445" }] },
  });
  const r = classifyReplaceVariantsBody(body, 200);
  assert.equal(r.kind, "ok");
});

test("200 with empty body → ok (no signal to interpret)", () => {
  assert.equal(classifyReplaceVariantsBody("", 200).kind, "ok");
  assert.equal(classifyReplaceVariantsBody(null, 200).kind, "ok");
  assert.equal(classifyReplaceVariantsBody(undefined, 200).kind, "ok");
});

test("200 with non-JSON body → ok (avoids misclassifying a heartbeat-style plain-text response)", () => {
  assert.equal(classifyReplaceVariantsBody("OK", 200).kind, "ok");
});

test("non-2xx → transient with the raw snippet (existing wire behaviour preserved)", () => {
  const r = classifyReplaceVariantsBody("Internal Server Error", 500);
  assert.equal(r.kind, "transient");
  if (r.kind === "transient") {
    assert.match(r.reason, /Appstle 500/);
    assert.match(r.reason, /Internal Server Error/);
  }
});

test("non-2xx with empty body → transient with 'no body' marker", () => {
  const r = classifyReplaceVariantsBody("", 502);
  assert.equal(r.kind, "transient");
  if (r.kind === "transient") assert.match(r.reason, /Appstle 502.*no body/);
});

test("200 with arrays / primitives instead of object → ok (not object-shaped, no decline)", () => {
  assert.equal(classifyReplaceVariantsBody("[]", 200).kind, "ok");
  assert.equal(classifyReplaceVariantsBody("true", 200).kind, "ok");
  assert.equal(classifyReplaceVariantsBody("42", 200).kind, "ok");
});
