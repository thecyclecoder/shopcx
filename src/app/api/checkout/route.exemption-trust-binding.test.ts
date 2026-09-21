/**
 * Regression test: the unauthenticated checkout commit + tax-quote routes must only apply a
 * customer's live sales-tax exemption when the caller carries a VERIFIED `sx_session` cookie for
 * the SAME workspace + customer as the cart — never from a body-supplied email, never from an
 * unauthenticated `/api/checkout/identify`-bound `cart.customer_id`.
 *
 * Fix 1 (spec Phase 4) removed the `.ilike("email", customerEmailForAvalara)` lookup and keyed the
 * resolver on `cart.customer_id`. That was still insufficient: `/api/checkout/identify` binds
 * `cart.customer_id` by caller-supplied email BEFORE any OTP verify, so an attacker who knows an
 * exempt customer's email can identify an open cart as that customer and get the exemption applied.
 * Fix 2 (spec Phase 5) gates the resolver on `readSessionFromRequest(request)` (the signed
 * `sx_session` cookie set only after OTP verify / magic-link click) and requires `session.w ===
 * cart.workspace_id` AND `session.c === cart.customer_id` before treating the customer id as
 * trusted; otherwise the exemption is null and Avalara computes normal tax.
 *
 * A route-level invocation harness is heavy for a single-predicate check, so this test asserts
 * the invariant at the source-code level — the shape the spec's "route-level probe" describes.
 * It reads BOTH src/app/api/checkout/route.ts AND src/app/api/checkout/tax-quote/route.ts and
 * gates each on:
 *
 *   1. The exemption resolution block MUST call `readSessionFromRequest` (import + call).
 *   2. The block MUST NOT `.ilike("email", …)` against `customers`, nor reference
 *      `customerEmailForAvalara` (the Fix-1 pre-fix bypass).
 *   3. The block MUST cross-check `session.w === cart.workspace_id` AND
 *      `session.c === cart.customer_id` (or `cartFull.customer_id`) — a bare cart.customer_id
 *      check WITHOUT a session cross-check is the Fix-2 pre-fix state and fails this test.
 *   4. The block MUST have a `: null` fallback for the untrusted-caller path.
 *
 * A regression that (a) drops the session check, (b) resurrects the email lookup, or (c) removes
 * the `: null` fallback reddens this test at authoring time.
 *
 * Run:  npm run test:checkout-exemption-trust-binding
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMMIT_ROUTE_PATH = join(__dirname, "route.ts");
const QUOTE_ROUTE_PATH = join(__dirname, "tax-quote", "route.ts");
const commitRouteText = readFileSync(COMMIT_ROUTE_PATH, "utf8");
const quoteRouteText = readFileSync(QUOTE_ROUTE_PATH, "utf8");

/**
 * Extract the exemption resolution block from a route file. The commit path opens with
 * `commitRegion` and closes at the `const commitExemption = ... : null;` assignment; the quote
 * path opens with `shipRegion` and closes at `const exemption = ... : null;`. Same shape both
 * ways — a `session` derivation, a `trustedCustomerId` derivation, then the resolver call.
 */
function commitBlock(text: string): string {
  const m = text.match(/commitRegion[\s\S]*?const commitExemption[\s\S]*?:\s*null;/);
  return m ? m[0] : "";
}
function quoteBlock(text: string): string {
  const m = text.match(/shipRegion[\s\S]*?const exemption[\s\S]*?:\s*null;/);
  return m ? m[0] : "";
}

test("commit route — exemption block reads and enforces sx_session", () => {
  const block = commitBlock(commitRouteText);
  assert.ok(
    block,
    "commit-time exemption resolution block not found in src/app/api/checkout/route.ts",
  );
  assert.ok(
    block.includes("readSessionFromRequest"),
    "regressed: commit exemption block no longer calls readSessionFromRequest — the signed " +
      "sx_session cookie is the ONLY trust source for exemption authorization on this " +
      "unauthenticated endpoint (Fix 2 of the spec):\n\n" + block,
  );
  assert.ok(
    /Session\.w\s*===\s*cart\.workspace_id/.test(block),
    "regressed: commit exemption block no longer cross-checks session.w against " +
      "cart.workspace_id — a session for another workspace must not authorize this cart's " +
      "exemption:\n\n" + block,
  );
  assert.ok(
    /Session\.c\s*===\s*cart\.customer_id/.test(block),
    "regressed: commit exemption block no longer cross-checks session.c against " +
      "cart.customer_id — an identify-bound cart.customer_id (which /api/checkout/identify " +
      "sets from body.email pre-OTP) must not authorize its exemption:\n\n" + block,
  );
});

test("commit route — exemption block does NOT ilike-lookup by email (Fix-1 pre-fix state)", () => {
  const block = commitBlock(commitRouteText);
  assert.ok(block);
  assert.ok(
    !/\.ilike\(\s*["']email["']/.test(block),
    "regressed: commit exemption block now uses .ilike('email', …) — the Fix-1 bypass:\n\n" + block,
  );
  assert.ok(
    !block.includes("customerEmailForAvalara"),
    "regressed: commit exemption block now references customerEmailForAvalara (body-derived):\n\n" +
      block,
  );
});

test("commit route — exemption block has a `: null` untrusted-caller fallback", () => {
  const block = commitBlock(commitRouteText);
  assert.ok(block);
  assert.ok(
    /:\s*null/.test(block),
    "regressed: commit exemption block has no `: null` fallback — an untrusted caller MUST " +
      "get a null commitExemption so Avalara commits normal tax:\n\n" + block,
  );
});

test("tax-quote route — exemption block reads and enforces sx_session", () => {
  const block = quoteBlock(quoteRouteText);
  assert.ok(
    block,
    "quote-time exemption resolution block not found in src/app/api/checkout/tax-quote/route.ts",
  );
  assert.ok(
    block.includes("readSessionFromRequest"),
    "regressed: quote exemption block no longer calls readSessionFromRequest — the previewed " +
      "tax quote for an exempt customer must not be visible to an unauthenticated caller who " +
      "guessed the email:\n\n" + block,
  );
  assert.ok(
    /Session\.w\s*===/.test(block) && /Session\.c\s*===/.test(block),
    "regressed: quote exemption block no longer cross-checks session.w and session.c against " +
      "cart.workspace_id / cartFull.customer_id — a bare cart.customer_id check without a " +
      "session cross-check IS the Fix-2 pre-fix state:\n\n" + block,
  );
});

test("tax-quote route — exemption block has a `: null` untrusted-caller fallback", () => {
  const block = quoteBlock(quoteRouteText);
  assert.ok(block);
  assert.ok(
    /:\s*null/.test(block),
    "regressed: quote exemption block has no `: null` fallback — an untrusted caller MUST see " +
      "a fully-taxable quote:\n\n" + block,
  );
});
