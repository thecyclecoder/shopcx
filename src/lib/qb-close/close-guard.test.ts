/**
 * Pins `assessDryRun` — the gate that decides whether a month-end close may post.
 *
 * Every case here is a real July 2026 failure, not a hypothetical. The close is largely
 * irreversible (the InventoryAdjustment + SalesReceipts have no void and no dedup), and the
 * defect class that actually bit us was never a crash — it was a **silently degraded input**
 * producing a confident, balanced, wrong close. So the wedge is: an input we cannot VERIFY must
 * block, and must never be read as a legitimate zero.
 *
 * Run: npx tsx --test src/lib/qb-close/close-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assessDryRun, JE_BALANCE_TOLERANCE, type AssessDryRunInput } from "./close-guard";
import type { MonthEndArtifacts } from "./month-end";

const PERIOD_END = "2026-07-31";

/** A healthy July close: balanced JE, full opening book, period-end snapshots, receipts verified. */
function artifacts(over: Partial<MonthEndArtifacts["meta"]> = {}, jeOver: Partial<MonthEndArtifacts["journalEntry"]> = {}): MonthEndArtifacts {
  return {
    month: "2026-07",
    journalEntry: {
      lines: [{ amount: 1, posting: "Debit", accountId: "1", accountName: "x", description: "" }],
      warnings: [],
      totalDebits: 238839.13,
      totalCredits: 238839.13,
      ...jeOver,
    } as MonthEndArtifacts["journalEntry"],
    receipts: {
      amazon: [{ itemRef: "1", qty: 657 }],
      shopify: [{ itemRef: "2", qty: 3563 }],
      internal: [{ itemRef: "3", qty: 122 }],
    } as MonthEndArtifacts["receipts"],
    inventoryAdjustment: [{ itemRef: "1", qtyDiff: 80 }],
    auditRows: [{ product_id: "p1", quickbooks_id: "1", variance: 80, actual: 9678 }],
    meta: {
      priorMonth: "2026-06",
      qbBasisRows: 86,
      fbaSnapshotDate: PERIOD_END,
      tplSnapshotDate: PERIOD_END,
      shopifyOrderCount: 2048,
      receivedItemCount: 1,
      ...over,
    },
  };
}

const input = (over: Partial<AssessDryRunInput> = {}): AssessDryRunInput => ({
  artifacts: artifacts(),
  processorsPresent: ["shopify_payments", "paypal", "braintree"],
  receiptsLookupOk: true,
  periodEnd: PERIOD_END,
  adjustmentValue: 2364.08,
  recentAdjustmentValues: [3284.82, 2054.86],
  ...over,
});

const codes = (i: AssessDryRunInput) => assessDryRun(i).blocking.map((b) => b.code);

test("a healthy July close passes with no blocking issues", () => {
  const out = assessDryRun(input());
  assert.equal(out.passed, true);
  assert.deepEqual(out.blocking, []);
  assert.equal(out.jeBalanced, true);
  assert.equal(out.inputHealth.opening_book_rows, 86);
});

test("empty opening book blocks — it reads as zero, not as an error", () => {
  // The real signature: a missing prior-month month_end_post made every item look like a total
  // loss and produced a 1,097,674-unit adjustment.
  const out = assessDryRun(input({ artifacts: artifacts({ qbBasisRows: 0 }) }));
  assert.equal(out.passed, false);
  assert.ok(out.blocking.some((b) => b.code === "empty_opening_book"));
});

test("a failed receipts lookup blocks, and is NOT treated as 'nothing received'", () => {
  // July: a dead QuickBooks connection returned 0 received for all 56 items behind a bare
  // catch {}, booking a $67,131 phantom gain.
  const out = assessDryRun(input({ receiptsLookupOk: false, artifacts: artifacts({ receivedItemCount: 0 }) }));
  assert.equal(out.passed, false);
  assert.ok(out.blocking.some((b) => b.code === "receipts_lookup_unavailable"));
});

test("a SUCCESSFUL lookup returning zero items is a warning, not a blocker", () => {
  const out = assessDryRun(input({ receiptsLookupOk: true, artifacts: artifacts({ receivedItemCount: 0 }) }));
  assert.equal(out.passed, true);
  assert.ok(out.warnings.some((w) => /genuinely no inventory received/i.test(w)));
});

test("a missing processor rollup blocks", () => {
  const out = assessDryRun(input({ processorsPresent: ["shopify_payments", "paypal"] }));
  assert.equal(out.passed, false);
  const issue = out.blocking.find((b) => b.code === "missing_processor_summaries");
  assert.ok(issue && /braintree/.test(issue.detail));
});

test("an out-of-balance JE blocks — QuickBooks rejects beyond a cent", () => {
  // July was out by exactly $48.27 from one dropped internal order line.
  const out = assessDryRun(input({ artifacts: artifacts({}, { totalDebits: 238839.13, totalCredits: 238790.86 }) }));
  assert.equal(out.passed, false);
  assert.equal(out.jeBalanced, false);
  const issue = out.blocking.find((b) => b.code === "je_out_of_balance");
  assert.ok(issue && issue.detail.includes("48.27"));
});

test("a sub-tolerance rounding difference still passes", () => {
  const out = assessDryRun(input({ artifacts: artifacts({}, { totalDebits: 100.0, totalCredits: 100 - JE_BALANCE_TOLERANCE }) }));
  assert.equal(out.jeBalanced, true);
  assert.equal(out.passed, true);
});

test("a physical snapshot that is not period-end blocks", () => {
  const out = assessDryRun(input({ artifacts: artifacts({ tplSnapshotDate: "2026-07-23" }) }));
  assert.equal(out.passed, false);
  assert.ok(out.blocking.some((b) => b.code === "stale_physical_snapshot"));
});

test("a missing physical snapshot blocks", () => {
  const out = assessDryRun(input({ artifacts: artifacts({ fbaSnapshotDate: null }) }));
  assert.ok(codes(input({ artifacts: artifacts({ fbaSnapshotDate: null }) })).includes("no_physical_snapshot"));
  assert.equal(out.passed, false);
});

test("an adjustment far outside the recent band blocks", () => {
  // July's first run: $85,864 against a $2-3K run-rate, none of it real shrinkage.
  const out = assessDryRun(input({ adjustmentValue: 85864 }));
  assert.equal(out.passed, false);
  const issue = out.blocking.find((b) => b.code === "adjustment_implausible");
  assert.ok(issue && /85864|85,864/.test(issue.detail.replace(/\.\d+/, "")));
});

test("the plausibility band is skipped when there is no history to compare against", () => {
  const out = assessDryRun(input({ adjustmentValue: 85864, recentAdjustmentValues: [] }));
  assert.ok(!out.blocking.some((b) => b.code === "adjustment_implausible"));
});

test("every blocking issue is reported at once, not just the first", () => {
  // An operator fixing one input at a time and re-running is exactly how six passes happened;
  // surfacing all of them collapses that loop.
  const out = assessDryRun(
    input({
      artifacts: artifacts({ qbBasisRows: 0, tplSnapshotDate: null }, { totalDebits: 10, totalCredits: 9 }),
      processorsPresent: [],
      receiptsLookupOk: false,
    }),
  );
  assert.equal(out.passed, false);
  const found = out.blocking.map((b) => b.code);
  for (const c of ["empty_opening_book", "missing_processor_summaries", "receipts_lookup_unavailable", "no_physical_snapshot", "je_out_of_balance"])
    assert.ok(found.includes(c as never), `expected ${c} in ${found.join(",")}`);
});
