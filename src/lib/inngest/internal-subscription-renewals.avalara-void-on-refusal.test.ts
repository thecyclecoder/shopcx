/**
 * F11: the internal renewal COMMITS its Avalara SalesInvoice before the claim and in-flight guards.
 * Every refusal after the commit returns without a Braintree sale, so it must void the invoice the
 * way the failed-charge path does. Otherwise each refused duplicate leaves a committed invoice with
 * no sale, and the company remits sales tax it never collected.
 *
 * Source-level, like the other renewal wiring tests: the worker is one Inngest handler and the
 * refusals are early returns inside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "internal-subscription-renewals.ts"), "utf8");
const commitAt = SRC.indexOf('step.run("avalara-commit"');
const saleAt = SRC.indexOf('step.run("braintree-sale"');

test("the commit happens before the guards (the reason the void is needed)", () => {
  assert.ok(commitAt > 0 && saleAt > commitAt);
  for (const guard of ['"claim-charge-idempotency"', '"check-subscription-in-flight"']) {
    const at = SRC.indexOf(guard);
    assert.ok(at > commitAt && at < saleAt, `${guard} must sit between the commit and the sale`);
  }
});

test("the refusal helper voids the committed invoice and never throws", () => {
  const helper = SRC.slice(SRC.indexOf("const voidCommittedTaxOnRefusal"), SRC.indexOf("const totalCents ="));
  assert.match(helper, /if \(!avalaraTransactionCode\) return;/);
  assert.match(helper, /voidTransaction\(workspace_id, avalaraTransactionCode\)/);
  assert.match(helper, /catch \(err\)/, "a failed void must not fail the refusal");
});

for (const reason of ["missing_dispatched_cycle", "refused_concurrent_renewal", "refused_duplicate_cycle"]) {
  test(`the ${reason} refusal voids the invoice before it returns`, () => {
    // The early RETURN for this refusal (not the same string inside a log payload).
    const m = new RegExp(`return \\{\\s*skipped: true,\\s*reason: "${reason}"`).exec(SRC.slice(commitAt));
    assert.ok(m, `the ${reason} return must exist after the commit`);
    const ret = commitAt + m.index;
    assert.ok(ret < saleAt, `the ${reason} return must sit before the sale`);
    // The void call is the statement just above this return.
    assert.match(SRC.slice(ret - 200, ret), /await voidCommittedTaxOnRefusal\("avalara-void-on-[a-z-]+"\);\s*$/);
  });
}

test("every refusal between the commit and the sale is covered", () => {
  const between = SRC.slice(commitAt, saleAt);
  // `zero_total` is not a refusal: it is a real $0 renewal (100%-off coupon) that advances the
  // calendar, and its invoice is a true $0 sale.
  const refusals = (between.match(/return \{\s*skipped: true,\s*reason: "[a-z_]+"/g) ?? [])
    .filter((r) => !r.includes('"zero_total"'));
  const voids = between.match(/await voidCommittedTaxOnRefusal\(/g) ?? [];
  assert.equal(voids.length, refusals.length, "one void per refusal return");
});
