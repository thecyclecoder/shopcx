/**
 * Pins the contract-agreement boundary that keeps a Shopify-scheduled late date out of the
 * unexplained-late escalation.
 *   npx tsx --test src/lib/commerce/shopcx-drift-reconciler.contract-agreement.test.ts
 *
 * The cadence analyzer paged `shopcx-subscription-health:late` on subs whose next_billing_date was
 * identical to their live Shopify contract's nextBillingDate — a date Shopify itself scheduled via a
 * billing anchor or first-cycle alignment, not drift we caused. A late sub flagged
 * `contractAgreesWithNextDate` is counted in the heartbeat but must NEVER escalate, the same way
 * dunning-held / inherited / internal / customer-scheduled lateness is already suppressed. This
 * asserts the exact predicate boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isEscalatableLate, type LateSub } from "./shopcx-drift-reconciler";

/** An otherwise-unexplained late sub — the only reason it would page is raw cadence lateness. */
function baseLate(overrides: Partial<LateSub> = {}): LateSub {
  return {
    contractId: "gid://shopify/SubscriptionContract/1",
    cadenceDays: 30,
    extraDays: 45,
    lastChargedAt: "2026-09-01T00:00:00.000Z",
    nextBillingDate: "2026-11-15T00:00:00.000Z",
    inDunning: false,
    inheritedFromAppstle: false,
    internalAccount: false,
    customerScheduled: false,
    contractAgreesWithNextDate: false,
    ...overrides,
  };
}

test("a late sub whose date the contract itself holds is NOT escalatable", () => {
  assert.equal(isEscalatableLate(baseLate({ contractAgreesWithNextDate: true })), false);
});

test("an otherwise-identical late sub the contract does NOT agree with still escalates", () => {
  assert.equal(isEscalatableLate(baseLate({ contractAgreesWithNextDate: false })), true);
});

test("contract-agreement is the only differentiator between the two cases", () => {
  const paging = baseLate({ contractAgreesWithNextDate: false });
  const suppressed = baseLate({ contractAgreesWithNextDate: true });
  // Every other benign flag is false on both — the escalation verdict flips solely on the new flag.
  assert.equal(isEscalatableLate(paging), true);
  assert.equal(isEscalatableLate(suppressed), false);
});

test("an undefined flag (older callers) behaves like false and still escalates", () => {
  const l = baseLate();
  delete l.contractAgreesWithNextDate;
  assert.equal(isEscalatableLate(l), true);
});
