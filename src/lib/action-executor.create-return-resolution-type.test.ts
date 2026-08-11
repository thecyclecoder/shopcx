/**
 * Unit tests for the create_return direct action's resolution_type passthrough —
 * Phase 1 of create-return-direct-action-honors-store-credit-resolution.
 *
 * The returns engine already supports resolving a return as store credit
 * (createFullReturn.resolutionType, src/lib/shopify-returns.ts), but the
 * create_return direct-action handler previously built its createFullReturn
 * call WITHOUT that field so an agent-created return was always forced to
 * refund_return. Phase 1 threads the parameter through: `p.resolution_type`
 * on ActionParams → `resolveCreateReturnResolutionType` → passed as
 * `resolutionType` into createFullReturn. Omitting keeps today's behavior
 * exactly (undefined → createFullReturn writes 'refund_return').
 *
 * The tests below pin the passthrough on the pure resolver that the handler
 * calls (its only caller — grep-verifiable). That is the value that reaches
 * createFullReturn's resolutionType parameter.
 *
 *   npx tsx --test src/lib/action-executor.create-return-resolution-type.test.ts
 *   (Registered as `test:create-return-resolution-type` in package.json → check:tests-registered.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCreateReturnResolutionType } from "./action-executor";

test("omitted resolution_type → resolver returns undefined so createFullReturn's built-in 'refund_return' default fires (today's behavior on every call site)", () => {
  const r = resolveCreateReturnResolutionType(undefined);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resolutionType, undefined);
});

test("resolution_type='store_credit_return' reaches createFullReturn — the sanctioned retention outcome an agent could not reach before", () => {
  const r = resolveCreateReturnResolutionType("store_credit_return");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resolutionType, "store_credit_return");
});

test("resolution_type='refund_return' is passed through unchanged (explicit today-shape)", () => {
  const r = resolveCreateReturnResolutionType("refund_return");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.resolutionType, "refund_return");
});

test("an unsupported string (e.g. one of the no-return flavors) is REJECTED — never silently downgrades to the refund_return default", () => {
  for (const bad of ["store_credit_no_return", "refund_no_return", "refund", "store_credit", "credit_return", ""]) {
    const r = resolveCreateReturnResolutionType(bad);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    if (r.ok) continue;
    assert.match(r.error, /Invalid resolution_type/);
    assert.match(r.error, /'refund_return' or 'store_credit_return'/);
  }
});

test("a non-string value is REJECTED (guards against a numeric/bool/object payload smuggled by a model)", () => {
  for (const bad of [0, 1, true, false, null, {}, ["store_credit_return"]]) {
    const r = resolveCreateReturnResolutionType(bad);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("the handler's grep-verifiable wiring — every literal 'resolutionType' emitted by the create_return path uses the resolver's return value (never p.resolution_type raw)", async () => {
  // Belt-and-braces regression pin: read the handler source and assert the
  // resolver output — not the raw ActionParams field — is what flows into
  // createFullReturn. This closes the exact class of bug Phase 1 fixes: a
  // future edit that reintroduces `resolutionType: p.resolution_type` would
  // bypass the validator (a bogus value would silently downgrade to the
  // refund default instead of surfacing as an error).
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./action-executor.ts", import.meta.url), "utf8");

  // Isolate the create_return handler body up through the next handler entry —
  // roughly the block from `create_return: async` to the next top-level handler
  // key (`partial_refund:`). This is coarse but robust: it captures the entire
  // createFullReturn call site regardless of intermediate nesting.
  const handlerStart = src.indexOf("create_return: async");
  assert.notEqual(handlerStart, -1, "create_return handler must exist in action-executor.ts");
  const handlerBody = src.slice(handlerStart, src.indexOf("partial_refund:", handlerStart));
  assert.ok(handlerBody.length > 0, "handler body slice must span through the createFullReturn call");

  assert.match(
    handlerBody,
    /resolutionType:\s*resolution\.resolutionType/,
    "create_return handler must pass the resolver's normalized value (resolution.resolutionType) into createFullReturn — never p.resolution_type raw",
  );
  assert.doesNotMatch(
    handlerBody,
    /resolutionType:\s*p\.resolution_type\b/,
    "raw p.resolution_type must never flow directly into createFullReturn — the resolver is the validation gate",
  );
});
