/**
 * Pins the dunning-status boundary that keeps terminal-dunning subs out of the unexplained-late
 * escalation.
 *   npx tsx --test src/lib/commerce/shopcx-drift-reconciler.dunning-statuses.test.ts
 *
 * A failed-card subscription whose current cycle has gone through dunning is late for a known,
 * dunning-owned reason — not scheduling drift. The terminal outcomes (exhausted/recovered) were
 * originally missing from the filter, so an exhausted-dunning sub was mis-classified as drift and
 * paged `shopcx-subscription-health:late` falsely. This asserts the exact boundary that was missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DUNNING_STATUSES_EXPLAINING_LATENESS } from "./shopcx-drift-reconciler";

test("terminal dunning states explain lateness", () => {
  assert.ok(DUNNING_STATUSES_EXPLAINING_LATENESS.includes("exhausted"), "must include 'exhausted'");
  assert.ok(DUNNING_STATUSES_EXPLAINING_LATENESS.includes("recovered"), "must include 'recovered'");
});

test("all original open dunning states are preserved", () => {
  for (const s of ["active", "rotating", "retrying", "skipped", "paused"] as const) {
    assert.ok(DUNNING_STATUSES_EXPLAINING_LATENESS.includes(s), `must include '${s}'`);
  }
});
