/**
 * New-card recovery must resolve the LIVE contract and advance the next billing date on BOTH paths.
 *
 * Every exhausted dunning cycle carries a PRE-MIGRATION shopify_contract_id (ground truth: old
 * 27900379309 → live contract 58099171501). subscriptionAction resolves that internally, but the
 * LOCAL writes — the status update in the reactivate step and the subscriptions update + Shopify
 * date push inside resetBillingDateAfterDunning — key on the id literally, so a stale contract id
 * matched zero rows. Worse, the reactivate path (2a) charged but NEVER called
 * resetBillingDateAfterDunning at all, so next_billing_date stayed in the past and the renewal cron
 * re-billed the same period the next day. Ground truth: customer e04ce897 charged SC142003 on
 * 2026-11-10 (new_card_retry) then SC142110 on 2026-11-11 (renewal, cycle_key 2026-11-11), refunded
 * by the founder on 2026-11-12.
 *
 * This pins the source shape: each step resolves resolveLiveContractId up front, uses it for every
 * write, and the reactivate step advances the date after its success check — never passing a raw
 * cycle.shopify_contract_id / cancelled.contractId to resetBillingDateAfterDunning or a
 * subscriptions update.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "dunning.ts"), "utf8");
const fn = SRC.slice(
  SRC.indexOf("export const dunningNewCardRecovery"),
  SRC.indexOf("// ── dunning/billing-success ──"),
);
const reactivate = fn.slice(fn.indexOf("step.run(`reactivate-"), fn.indexOf("step.run(`recover-"));
const recover = fn.slice(fn.indexOf("step.run(`recover-"), fn.indexOf("// Step 3"));

test("the reactivate (2a) step resolves the live contract before its first subscriptionAction", () => {
  const resolve = reactivate.indexOf("resolveLiveContractId(");
  const action = reactivate.indexOf("subscriptionAction(");
  assert.ok(resolve > -1, "reactivate step must call resolveLiveContractId");
  assert.ok(action > resolve, "resolveLiveContractId must precede the first subscriptionAction");
});

test("the recover (2b) step resolves the live contract before its first charge and reactivation", () => {
  const resolve = recover.indexOf("resolveLiveContractId(");
  const charge = recover.indexOf("dunningChargeContract(");
  const action = recover.indexOf("subscriptionAction(");
  assert.ok(resolve > -1, "recover step must call resolveLiveContractId");
  assert.ok(charge > resolve, "resolveLiveContractId must precede dunningChargeContract");
  assert.ok(action > resolve, "resolveLiveContractId must precede the first subscriptionAction");
});

test("the reactivate step advances the billing date after its success check", () => {
  const success = reactivate.indexOf("if (billingRes.success)");
  const reset = reactivate.indexOf("resetBillingDateAfterDunning(");
  assert.ok(success > -1, "reactivate step must have a billingRes.success check");
  assert.ok(reset > success, "resetBillingDateAfterDunning must follow the success check");
  assert.match(reactivate, /resetBillingDateAfterDunning\(workspace_id, liveContractId, cancelled\.cycleId, true\)/);
});

test("the recover step advances the date on the live contract after success", () => {
  assert.match(recover, /resetBillingDateAfterDunning\(workspace_id, liveContractId, cycle\.id, true\)/);
});

test("neither step passes a raw pre-migration contract id to resetBillingDateAfterDunning", () => {
  assert.ok(
    !/resetBillingDateAfterDunning\(workspace_id, cancelled\.contractId/.test(reactivate),
    "reactivate must not pass cancelled.contractId to resetBillingDateAfterDunning",
  );
  assert.ok(
    !/resetBillingDateAfterDunning\(workspace_id, cycle\.shopify_contract_id/.test(recover),
    "recover must not pass cycle.shopify_contract_id to resetBillingDateAfterDunning",
  );
});

test("neither step keys a subscriptions update on a raw pre-migration contract id", () => {
  assert.ok(
    !/\.eq\("shopify_contract_id", cancelled\.contractId\)/.test(reactivate),
    "reactivate subscriptions writes must use the resolved liveContractId",
  );
  assert.ok(
    !/\.eq\("shopify_contract_id", cycle\.shopify_contract_id\)/.test(recover),
    "recover subscriptions reads/writes must use the resolved liveContractId",
  );
});
