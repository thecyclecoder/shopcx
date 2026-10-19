/**
 * Pins that a one-off "Prior Year Adjustment" never lands in real profit.
 *
 * Sep 2026 booked $125.5K to "85000 Prior Year Adjustment" (Other Expenses). Before this,
 * adjusted_net_income = net_income + management_fees read −$82.2K for a ~$43K month, and the
 * in-progress estimate (which averages adjusted − operating over 3 closed months) dragged
 * October down ~$42K. The fixture is the real September Other Expenses section, trimmed.
 *
 * Run: npx tsx --test src/lib/quickbooks.prior-year-adjustment.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePnlRollups } from "./quickbooks";

function report(otherExpenseRows: { name: string; value: string }[], netIncome: string) {
  return {
    Rows: {
      Row: [
        { type: "Section", group: "NetOperatingIncome", Summary: { ColData: [{ value: "Net Operating Income" }, { value: "41613.18" }] } },
        {
          type: "Section",
          group: "OtherExpenses",
          Header: { ColData: [{ value: "Other Expenses" }, { value: "" }] },
          Rows: { Row: otherExpenseRows.map((r) => ({ type: "Data", ColData: [{ value: r.name }, { value: r.value }] })) },
          Summary: { ColData: [{ value: "Total Other Expenses" }, { value: "0" }] },
        },
        { type: "Section", group: "NetIncome", Summary: { ColData: [{ value: "Net Income" }, { value: netIncome }] } },
      ],
    },
  };
}

test("September 2026: the prior-year adjustment is added back to real profit", () => {
  const r = parsePnlRollups(
    report(
      [
        { name: "80000 Interest Expense", value: "2652.21" },
        { name: "82000 Management Fees", value: "60000.00" },
        { name: "85000 Prior Year Adjustment", value: "125498.42" },
      ],
      "-142163.24",
    ),
  );
  assert.equal(r.net_income, -142163.24); // booked stays exactly as filed
  assert.equal(r.management_fees, 60000);
  assert.equal(r.prior_year_adjustments, 125498.42);
  assert.ok(Math.abs((r.adjusted_net_income ?? 0) - 43335.18) < 0.01);
});

test("a month with no prior-year adjustment is unchanged", () => {
  const r = parsePnlRollups(report([{ name: "82000 Management Fees", value: "60000.00" }], "5457.86"));
  assert.equal(r.prior_year_adjustments, null);
  assert.ok(Math.abs((r.adjusted_net_income ?? 0) - 65457.86) < 0.01);
});
