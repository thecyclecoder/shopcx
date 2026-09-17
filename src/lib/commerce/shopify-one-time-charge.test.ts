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

test("the Braintree branch spans the link group — a linked-sibling card is found (payment-method-lookups-must-span-linked-accounts Phase 1)", () => {
  // Ground truth: ticket 4ed092c4. MasterCard ••9762 vaulted on customer affcdc47, the charge
  // required linked sibling 40c66b13 (the one with a shopify_customer_id). A bare
  // `.eq("customer_id", row.customer_id)` on `customer_payment_methods` missed the card, the
  // Braintree branch returned null, and the executor silently fell through to the Shopify rail —
  // billing an Amex ••1002 that had already declined. The widened lookup uses linkGroupIds so
  // the card is found regardless of which linked record the caller happens to hold.
  const fn = SRC.slice(SRC.indexOf("async function chargeViaBraintreeIfPossible"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /linkGroupIds/, "the Braintree lookup must call linkGroupIds");
  assert.match(
    body,
    /\.in\("customer_id",\s*groupIds\)/,
    "the customer_payment_methods lookup must use `.in(customer_id, groupIds)` — not a bare `.eq(customer_id, row.customer_id)` that misses a linked sibling's card",
  );
  assert.doesNotMatch(
    body,
    /\.eq\("customer_id",\s*row\.customer_id\)/,
    "the pre-fix bare same-person lookup must be gone — that is the failing state this test pins",
  );
  assert.match(
    body,
    /customerId: row\.customer_id/,
    "the CHARGE identity is still the queue row's own customer_id — widening a LOOKUP is correct, re-pointing a CHARGE is not",
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

test("retryOneTimeCharge only reopens a `failed` row, via compare-and-set", () => {
  // The retry claim is what stops two operators (or an operator + a cron sweeping stuck rows)
  // from concurrently reopening the same row: it must be a CAS on status='failed', and the row
  // count is again the only signal because PostgREST returns no error on a zero-row update.
  const fn = SRC.slice(SRC.indexOf("export async function retryOneTimeCharge"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /if \(row\.status !== "failed"\) return \{ success: false, error: `not_failed/,
    "the initial check must gate on failed status");
  assert.match(body, /\.eq\("status", "failed"\)/,
    "the update must be a compare-and-set on status='failed'");
  assert.match(body, /if \(!data\?\.length\) return \{ success: false, error: "not_failed" \}/,
    "a zero-row update means another actor already reopened this row — refuse loudly");
});

test("retryOneTimeCharge refuses the same method that just declined", () => {
  // Every blind retry against the same instrument is a real decline on the customer's account.
  // The truth of "what just declined" is the payment_method_id ACTUALLY billed; fall back to
  // shopify_payment_method_id only when the executor failed before stamping the truth.
  const fn = SRC.slice(SRC.indexOf("export async function retryOneTimeCharge"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /same_method_as_last_decline/, "the same-method retry must be refused with a distinct reason");
  assert.match(
    body,
    /const lastBilled =[\s\S]*?row\.payment_method_id[\s\S]*?\?\?[\s\S]*?row\.shopify_payment_method_id/,
    "the guard compares against the method actually billed (payment_method_id), not just the caller-chosen field",
  );
});

test("the rail records WHY it was chosen — rail_reason is stamped at every rail-selection settle (payment-method-lookups-must-span-linked-accounts Phase 2)", () => {
  // Phase 2's whole point: on the Shopify rail, `rail='shopify'` alone is ambiguous — the caller
  // may have NAMED a Shopify method (explicit authorisation for this rail) or Braintree may have
  // MISSED (fell through). rail_reason must distinguish them at settle time so a Braintree miss
  // is legible on the row rather than inferred from a log line.
  const exec = SRC.slice(SRC.indexOf("export async function executeOneTimeCharge"));
  const body = exec.slice(0, exec.indexOf("\n}\n") + 3);

  assert.match(
    body,
    /railReason: RailReason \| null = null/,
    "the executor must carry a rail_reason variable across the flow, resolved at each decision point",
  );
  assert.match(
    body,
    /railReason = "braintree_preferred"/,
    "the Braintree branch must stamp rail_reason='braintree_preferred' when it runs",
  );
  assert.match(
    body,
    /railReason = chosenShopifyMethodId \? "shopify_named_instrument" : "shopify_no_braintree_token"/,
    "on the Shopify rail, rail_reason must distinguish a caller-named method from a Braintree miss — this is the legibility Phase 2 exists to add",
  );
  assert.match(
    body,
    /rail_reason: "braintree_indeterminate"/,
    "a Braintree throw settles as terminal + loud with rail_reason='braintree_indeterminate'",
  );
  // The rail_reason value must reach the terminal / pending settle sites.
  assert.match(body, /rail_reason: railReason/,
    "railReason must be persisted on the settle patch (the row is the durable legibility surface)");
});

test("named Shopify instrument miss REFUSES — never falls back to a different card (Phase 2 invariant)", () => {
  // The whole reason for Phase 2: charging a different card than the one authorised is the
  // failure this phase exists to prevent. resolveShopifyContext already returns
  // chosen_payment_method_not_found / chosen_payment_method_revoked; the executor must forward
  // that error via fail(...) rather than silently falling through to any other lookup.
  const exec = SRC.slice(SRC.indexOf("export async function executeOneTimeCharge"));
  const body = exec.slice(0, exec.indexOf("\n}\n") + 3);
  const resolveCall = body.indexOf("resolveShopifyContext");
  assert.ok(resolveCall > 0, "the executor must call resolveShopifyContext for the Shopify rail");
  const after = body.slice(resolveCall);
  assert.match(
    after,
    /if \("error" in ctx\) \{[\s\S]{0,500}?return fail\(ctx\.error, \{ rail: "shopify", railReason \}\)/,
    "a resolver error (named-instrument miss included) must be forwarded to fail() with the current rail + railReason — never a silent fallback",
  );
});

test("rail_reason migration exists and constrains to the enumerated set", () => {
  const RAIL_REASON_MIGRATION = readFileSync(
    join(__dirname, "../../../supabase/migrations/20261232120000_one_time_charges_rail_reason.sql"),
    "utf8",
  );
  assert.match(RAIL_REASON_MIGRATION, /ADD COLUMN IF NOT EXISTS rail_reason text/);
  assert.match(
    RAIL_REASON_MIGRATION,
    /rail_reason IS NULL OR rail_reason IN \([\s\S]*?'braintree_preferred'[\s\S]*?'braintree_indeterminate'[\s\S]*?'shopify_named_instrument'[\s\S]*?'shopify_no_braintree_token'/,
    "the CHECK must enumerate exactly the four allowed values (a fifth would be a silent write nobody notices)",
  );
  assert.doesNotMatch(RAIL_REASON_MIGRATION, /NOT NULL/i,
    "the column must be nullable — existing rows don't need to be backfilled");
});

test("retryOneTimeCharge clears rail_reason and preserves the prior one on attempt_history", () => {
  // A retry re-attempts the charge on a new method, so the prior attempt's rail_reason belongs on
  // attempt_history (part of the decline signature the human sees), and the reopened row's own
  // rail_reason must be cleared so a stale value can't be misread as this attempt's outcome.
  const fn = SRC.slice(SRC.indexOf("export async function retryOneTimeCharge"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /rail_reason: \(row\.rail_reason as string \| null\) \?\? null/,
    "the appended history entry must carry the prior rail_reason");
  assert.match(body, /rail_reason: null,\s*failed_at: null/,
    "the reopen update must clear rail_reason on the row itself");
});

test("retryOneTimeCharge appends prior attempt to attempt_history before reopening", () => {
  // The whole point of retrying on the SAME row is to preserve the decline history without a
  // duplicate charge row. The prior attempt's signature must be captured BEFORE the row is
  // reopened (fields cleared), so the human deciding what to try next sees the full history.
  const fn = SRC.slice(SRC.indexOf("export async function retryOneTimeCharge"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  const historyIdx = body.indexOf("attempt_history: nextHistory");
  const updateIdx = body.indexOf('status: "pending"');
  assert.ok(historyIdx > 0, "the update must set attempt_history to the appended history");
  assert.ok(updateIdx > 0, "the update must reopen the row to pending");
  const priorAppend = body.indexOf("const nextHistory = [");
  assert.ok(priorAppend > 0 && priorAppend < updateIdx,
    "attempt_history must be built BEFORE the reopen update, not after");
  assert.match(body, /payment_method_id: \(row\.payment_method_id [^,]*\) \?\? null/,
    "the appended entry must carry the payment method that just declined");
});

test("the attempt_history migration exists and is nullable-safe for existing rows", () => {
  const HIST_MIGRATION = readFileSync(
    join(__dirname, "../../../supabase/migrations/20261231120001_one_time_charges_attempt_history.sql"),
    "utf8",
  );
  assert.match(HIST_MIGRATION, /ADD COLUMN IF NOT EXISTS attempt_history jsonb/);
  assert.match(HIST_MIGRATION, /DEFAULT '\[\]'::jsonb/,
    "existing rows must read as an empty array — no NULL surprises when the column is scanned");
});
