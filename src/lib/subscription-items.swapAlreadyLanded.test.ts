/**
 * Regression test for the swap-variant self-heal must-not-refire-an-already-landed-swap fix.
 *
 * Spec: [[../../docs/brain/specs/swap-variant-self-heal-must-not-refire-an-already-landed-swap]]
 * Ticket 46a77d60 (Christine, 2026-08-05): the crisis auto-swap-back to Mixed Berry succeeded on
 * contract 33827422381, but the self-heal retry re-invoked `subSwapVariant` against the OUTGOING
 * variant (Peach Mango 42614433513645) — a line the first swap had already removed. The
 * price-capture guard (`captureOutgoingRealizedCents`) correctly refused with
 * `Cannot read outgoing line price ... swap refused to prevent a silent price reset`, but the
 * refusal was spurious: the swap had already landed. The customer got a scary "I ran into a small
 * issue" reply after threatening non-payment.
 *
 * The fix in `subSwapVariant` runs `verifyContractEndState` BEFORE the price capture; if identity
 * is already satisfied (new present, old absent) it returns success without re-invoking Appstle.
 * This test asserts the pure identity-check pieces on which that short-circuit relies produce the
 * right verdict for the already-landed shape AND still fail loudly for the 2026-07-30 partial-
 * apply shapes the short-circuit must not weaken.
 *
 * Run:
 *   npx tsx --test src/lib/subscription-items.swapAlreadyLanded.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkContractSatisfiesExpectation,
  identityExpectationForSwap,
} from "./subscription-items";

const line = (variantId: string, quantity = 1) => ({
  variantId: `gid://shopify/ProductVariant/${variantId}`,
  quantity,
  pricingPolicy: null,
});

test("already-landed swap — new present + old absent → verdict OK (short-circuits self-heal)", () => {
  // Christine's ticket 46a77d60 shape: the contract holds Mixed Berry only; Peach Mango is gone
  // because the first swap already succeeded. The self-heal must recognize THIS shape and
  // short-circuit instead of re-firing subSwapVariant against the removed outgoing line.
  const expected = identityExpectationForSwap("PEACH_MANGO", "MIXED_BERRY", 1);
  const verdict = checkContractSatisfiesExpectation([line("MIXED_BERRY", 1)], expected);
  assert.equal(verdict.ok, true);
});

test("already-landed swap at higher quantity — new present at ≥ requested qty, old absent → verdict OK", () => {
  // Appstle sometimes merges into an existing line; the `swap` verdict allows quantity to be a
  // lower bound (`add` semantics on the new-present half), so a merged higher-qty line still
  // counts as landed.
  const expected = identityExpectationForSwap("OLD-1", "NEW-2", 1);
  const verdict = checkContractSatisfiesExpectation([line("NEW-2", 3)], expected);
  assert.equal(verdict.ok, true);
});

test("not-yet-landed — old still present, new absent → verdict FAILS (self-heal must fire)", () => {
  // The 2xx-no-op shape (Appstle returned success but never moved the flavour). Identity must NOT
  // pass here — the short-circuit would otherwise turn a real "the swap never happened" into a
  // silent success and let the customer ship the wrong thing.
  const expected = identityExpectationForSwap("OLD-1", "NEW-2", 1);
  const verdict = checkContractSatisfiesExpectation([line("OLD-1", 1)], expected);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /new variant NEW-2 present/);
});

test("partial-apply — both new AND old on contract → verdict FAILS (short-circuit must not weaken 2026-07-30 defense)", () => {
  // The 2026-07-30 crisis shape: Appstle applied the add but didn't remove the old. The strict
  // `swap` verdict requires old absent, so this must still fail. If the short-circuit ever
  // relaxed to "new present is enough", a partial-apply would false-pass and the customer would
  // durable-store an unresolved double-line.
  const expected = identityExpectationForSwap("OLD-1", "NEW-2", 1);
  const verdict = checkContractSatisfiesExpectation(
    [line("OLD-1", 1), line("NEW-2", 1)],
    expected,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /OLD-1 absent/);
});

test("syncItemsAfterMutation — read AND write are scoped by BOTH workspace_id and shopify_contract_id (tenant-boundary regression guard)", () => {
  // The new already-landed early-return in subSwapVariant calls syncItemsAfterMutation BEFORE any
  // Appstle mutation. That helper uses createAdminClient() (service-role, bypasses RLS), so scoping
  // by shopify_contract_id alone can cross tenants — the same Shopify contract number can exist in
  // more than one workspace. Both the SELECT and the UPDATE must include workspace_id, and the
  // read must be maybeSingle so a zero-row result is a bail (not an error that silently skips the
  // update). This is a static-source assertion because the helper is not exported and the seam
  // isn't mockable without a networked Supabase client.
  const src = readFileSync(join(__dirname, "subscription-items.ts"), "utf8");
  const startIdx = src.indexOf("async function syncItemsAfterMutation(");
  assert.ok(startIdx >= 0, "syncItemsAfterMutation must exist in subscription-items.ts");
  // Body extends until the closing `}` before the next top-level declaration.
  const bodyEnd = src.indexOf("\n}\n", startIdx);
  assert.ok(bodyEnd > startIdx, "must locate syncItemsAfterMutation body");
  const body = src.slice(startIdx, bodyEnd);

  const wsEqs = body.match(/\.eq\("workspace_id",\s*workspaceId\)/g) ?? [];
  const contractEqs = body.match(/\.eq\("shopify_contract_id",\s*contractId\)/g) ?? [];
  assert.equal(
    wsEqs.length,
    2,
    `syncItemsAfterMutation must scope BOTH the select AND the update by workspace_id (found ${wsEqs.length}, need 2)`,
  );
  assert.equal(
    contractEqs.length,
    2,
    `syncItemsAfterMutation must scope BOTH the select AND the update by shopify_contract_id (found ${contractEqs.length}, need 2)`,
  );
  assert.ok(
    /\.maybeSingle\(\)/.test(body),
    "syncItemsAfterMutation select must use maybeSingle() so a no-row result is a bail, not a throw",
  );
  // A single() call would break the no-row bail — leave it out.
  assert.ok(
    !/\.single\(\)/.test(body),
    "syncItemsAfterMutation select must NOT use single() — a duplicate/cross-workspace hit would throw and skip the update",
  );
});
