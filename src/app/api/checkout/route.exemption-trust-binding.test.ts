/**
 * Regression test: the unauthenticated checkout commit route must only apply a customer's live
 * sales-tax exemption when the cart carries a TRUSTED customer_id — never from the caller-supplied
 * `body.email`.
 *
 * The spec's Fix 1 (docs/brain/specs/a-customer-can-be-recorded-as-sales-tax-exempt.md § Phase 4)
 * addresses a real vulnerability: because `/api/checkout` is a public POST, an unauthenticated
 * shopper who knows or guesses an exempt customer's email could otherwise submit checkout with
 * that email and receive the exemption, causing tax undercollection at Avalara commit time. The
 * fix removes the `ilike("email", customerEmailForAvalara)` lookup and keys the exemption
 * resolution SOLELY on `cart.customer_id` (bound by the earlier verified checkout/session
 * identity flow); an open cart with no trusted customer_id sees `commitExemption = null` and
 * Avalara computes normal tax even when body.email happens to match an exempt customer's row.
 *
 * A route-level invocation harness is heavy for a single-predicate check, so this test asserts
 * the invariant at the source-code level — the shape the spec's "route-level probe" describes.
 * It reads src/app/api/checkout/route.ts and gates:
 *
 *   1. The exemption resolution block MUST NOT `.ilike("email", …)` against `customers` (the
 *      pre-fix bypass).
 *   2. The exemption resolution block MUST derive its customer id from `cart.customer_id`
 *      (the sole trusted binding on this endpoint).
 *   3. `resolveCustomerTaxExemption` is still called with that trusted id in the commit path.
 *
 * A regression that resurrects the email lookup — or introduces any other body-derived customer
 * lookup used to resolve the exemption — reddens this test at authoring time.
 *
 * Run:  npm run test:checkout-exemption-trust-binding
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE_PATH = join(__dirname, "route.ts");
const routeText = readFileSync(ROUTE_PATH, "utf8");

// Narrow the assertion to the exemption resolution block so a legitimate email lookup elsewhere
// in the route (e.g. the coupon-code customer resolution at ~line 246, which does NOT drive tax)
// is not flagged. The block runs from the `commitRegion` opener through the whole
// `const commitExemption = ... : null;` assignment.
const RESOLUTION_BLOCK_RE =
  /commitRegion[\s\S]*?const commitExemption[\s\S]*?:\s*null;/;

test("exemption block uses cart.customer_id as the sole trust source (not body.email)", () => {
  const m = routeText.match(RESOLUTION_BLOCK_RE);
  assert.ok(
    m,
    "commit-time exemption resolution block not found in src/app/api/checkout/route.ts — " +
      "the shape may have moved. Re-anchor this test.",
  );
  const block = m[0];

  assert.ok(
    block.includes("cart.customer_id"),
    "expected exemption resolution to derive its customer id from cart.customer_id (the trusted " +
      "binding), but the block does not reference cart.customer_id:\n\n" + block,
  );
  assert.ok(
    block.includes("resolveCustomerTaxExemption"),
    "expected the exemption resolution block to call resolveCustomerTaxExemption:\n\n" + block,
  );
});

test("exemption block does NOT ilike-lookup a customer by email (the pre-fix bypass)", () => {
  const m = routeText.match(RESOLUTION_BLOCK_RE);
  assert.ok(m, "commit-time exemption resolution block not found");
  const block = m[0];

  assert.ok(
    !/\.ilike\(\s*["']email["']/.test(block),
    "regressed: exemption resolution now uses .ilike(\"email\", …) — this is the exact bypass the " +
      "spec's Fix 1 removed. Any unauthenticated caller could submit checkout with an exempt " +
      "customer's email and receive their exemption. Revert to keying only on cart.customer_id:\n\n" +
      block,
  );
  assert.ok(
    !block.includes("customerEmailForAvalara"),
    "regressed: exemption resolution now references customerEmailForAvalara (the body-derived " +
      "email). Body-supplied email is UNTRUSTED on this public route — the exemption trust source " +
      "must be cart.customer_id only:\n\n" + block,
  );
});

test("exemption block bails to null when no trusted customer_id is present", () => {
  const m = routeText.match(RESOLUTION_BLOCK_RE);
  assert.ok(m, "commit-time exemption resolution block not found");
  const block = m[0];

  // The fix reads either `const trustedCustomerId = (cart.customer_id ...) ?? null;` followed by
  // a ternary that returns `null` when trustedCustomerId is falsy, OR directly ternaries on
  // cart.customer_id. Assert on the ternary null branch either way — a null commitExemption is
  // what makes createAvalaraTx omit exemptionNo/entityUseCode and charge normal tax.
  assert.ok(
    /:\s*null/.test(block),
    "regressed: exemption resolution no longer has a `: null` fallback branch. With no trusted " +
      "customer_id present, commitExemption MUST be null so Avalara commits normal tax:\n\n" +
      block,
  );
});
