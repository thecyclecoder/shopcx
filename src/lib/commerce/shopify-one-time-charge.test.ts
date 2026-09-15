/**
 * Pins the three invariants that keep a one-time charge OUT of subscription statistics, and the
 * one that keeps it from charging twice. Each corresponds to a way this silently failed while
 * being built — none is catchable by tsc.
 *
 *  1. The order must NOT be classified `recurring`. A one-time charge bills through
 *     `subscriptionBillingAttemptCreate`, so Shopify stamps it
 *     `source_name='subscription_contract_checkout_one'` — identical to a real ShopCX renewal —
 *     and the workspace's `order_source_mapping` maps that source to `recurring`. Verified live on
 *     order SC138755.
 *  2. `orders.order_type` is CHECK-constrained, so the reclassifying UPDATE must READ its error.
 *     It was rejected with 23514 the first time and no-opped in silence.
 *  3. The Shopify contract must be cancelled on EVERY settled path. `billingPolicy.maxCycles` is
 *     NOT enforced — verified on contract 36017143981, created with maxCycles:1 and still showing
 *     8 addressable cycles — so cancellation is the only thing making the charge one-time.
 *  4. The claim is a compare-and-set on the row's own status, and PostgREST returns NO error when
 *     an update matches zero rows, so the returned ROW COUNT is the only signal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "shopify-one-time-charge.ts"), "utf8");
const MIGRATION = readFileSync(
  join(__dirname, "../../../supabase/migrations/20261229120001_one_time_charges.sql"),
  "utf8",
);

test("the one-time order type is not a subscription-ish type", async () => {
  const { ONE_TIME_ORDER_TYPE } = await import("./shopify-one-time-charge");
  assert.equal(ONE_TIME_ORDER_TYPE, "one_time");
  for (const forbidden of ["recurring", "checkout", "replacement"]) {
    assert.notEqual(ONE_TIME_ORDER_TYPE, forbidden);
  }
});

test("the orders.order_type CHECK is widened to accept it", () => {
  // A migration that stamps a value the CHECK rejects leaves every order misclassified.
  assert.match(MIGRATION, /orders_order_type_check/);
  assert.match(MIGRATION, /'one_time'::text/);
});

test("the reclassifying update reads its error", () => {
  const fn = SRC.slice(SRC.indexOf("async function backfillOrderLinks"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(
    body,
    /const \{ error: reclassErr \} = await admin[\s\S]*?order_type: ONE_TIME_ORDER_TYPE/,
    "the order_type update must destructure `error` — a CHECK violation is otherwise a silent no-op",
  );
  assert.match(body, /if \(reclassErr\)/);
});

test("the contract is cancelled in a finally, on every settled path", () => {
  const exec = SRC.slice(SRC.indexOf("export async function executeOneTimeCharge"));
  assert.match(exec, /\}\s*finally\s*\{/, "cancellation must be in a finally — a decline leaves a live contract otherwise");
  const fin = exec.slice(exec.indexOf("} finally {"));
  assert.match(fin, /shopifySubscriptionAction\(workspaceId, contractId, "cancel"\)/);
});

test("maxCycles is documented as NOT enforced, so nobody relies on it later", () => {
  assert.match(SRC, /maxCycles` DOES NOT BIND|maxCycles is NOT enforced|does not enforce/i);
  assert.match(MIGRATION, /maxCycles is NOT enforced/);
});

test("the claim checks the returned row count, not the error", () => {
  const claim = SRC.slice(SRC.indexOf("async function claim("));
  const body = claim.slice(0, claim.indexOf("\n}\n"));
  assert.match(body, /\.eq\("status", "pending"\)/, "the compare-and-set predicate is what makes it atomic");
  assert.match(body, /return !!data\?\.length/, "PostgREST returns no error on a zero-row update — count is the only signal");
});

test("a chosen shopify_payment_method_id is validated against the live list, not silently fallen back", () => {
  // The 2026-09-15 decline shape: a caller cannot name a card and the rail always picks
  // `live[0]`. If the chosen id is stale/revoked/absent it must FAIL LOUDLY, not silently bill a
  // different card than the one authorised.
  const fn = SRC.slice(SRC.indexOf("async function resolveShopifyContext"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /chosenPaymentMethodId\?: string \| null/, "the resolver must accept a chosen id");
  assert.match(body, /chosen_payment_method_not_found/, "an absent id must fail with a specific reason");
  assert.match(body, /chosen_payment_method_revoked/, "a revoked id must fail with a distinct reason so it is diagnosable");
  assert.match(
    body,
    /if \(chosenPaymentMethodId\)[\s\S]*?live\.find\([\s\S]*?p\.id === chosenPaymentMethodId/,
    "when a chosen id is present, selection must be by id equality against LIVE (non-revoked) methods — never last-four (one card can appear as multiple methods)",
  );
});

test("the migration adds the shopify_payment_method_id column", () => {
  // The optional input column: nullable, so today's callers are unaffected.
  const CHOSEN_MIGRATION = readFileSync(
    join(__dirname, "../../../supabase/migrations/20261231120000_one_time_charges_shopify_payment_method_id.sql"),
    "utf8",
  );
  assert.match(CHOSEN_MIGRATION, /ADD COLUMN IF NOT EXISTS shopify_payment_method_id text/);
  assert.doesNotMatch(CHOSEN_MIGRATION, /NOT NULL/i, "the column must be nullable — a NULL preserves the first-non-revoked default");
});

test("the executor persists the method actually billed BEFORE the contract call", () => {
  // The current log line named the instrument but nothing persisted it: a decline that landed
  // before the post-contract settle was un-attributable. Stamp `payment_method_id` right after
  // the payment method resolves so every settled outcome has the instrument on the row.
  const exec = SRC.slice(SRC.indexOf("export async function executeOneTimeCharge"));
  const until = exec.indexOf("shopifyCreateContract(");
  assert.ok(until > 0, "the executor must still call shopifyCreateContract");
  const pre = exec.slice(0, until);
  assert.match(
    pre,
    /settle\(workspaceId, chargeId, \{ payment_method_id: ctx\.paymentMethodId \}\)/,
    "payment_method_id must be persisted before the contract call, not only after it succeeds",
  );
});

test("a named shopify method skips the Braintree rail", () => {
  // A chosen `shopify_payment_method_id` is an explicit authorisation to bill THAT card via the
  // Shopify contract rail. Routing to a Braintree card would charge a different instrument than
  // the caller asked for.
  const exec = SRC.slice(SRC.indexOf("export async function executeOneTimeCharge"));
  const body = exec.slice(0, exec.indexOf("\n}\n") + 3);
  assert.match(
    body,
    /chosenShopifyMethodId \? null : await chargeViaBraintreeIfPossible/,
    "a caller-named Shopify method must bypass the Braintree preference",
  );
});
