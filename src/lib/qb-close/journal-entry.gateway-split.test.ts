/**
 * Pins the JE's per-gateway clearing allocation.
 *
 * The wedge is order SC134526 (2026-07): `payment_gateway_names` listed THREE gateways
 * (braintree + shopify_payments + PayPal Braintree) while a single one captured the entire
 * $263.51. Dividing equally credited two clearing accounts that received nothing. Across July's
 * 12 split-payment orders that was $1,540.23 of absolute misallocation.
 *
 * Run: npx tsx --test src/lib/qb-close/journal-entry.gateway-split.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildJournalEntryLines, type JournalEntryInputs, type ShopifyOrder } from "./journal-entry";

const ACCT: Record<string, { value: string; name: string }> = {
  shopify_clearing: { value: "1", name: "Clearing:Shopify" },
  braintree_clearing: { value: "2", name: "Clearing:Braintree" },
  paypal_clearing: { value: "3", name: "Clearing:PayPal" },
  shopify_txn_fees: { value: "4", name: "Fees:Shopify" },
  braintree_txn_fees: { value: "5", name: "Fees:Braintree" },
  paypal_txn_fees: { value: "6", name: "Fees:PayPal" },
  refunds_account: { value: "7", name: "Contra:Refunds" },
  chargebacks_account: { value: "8", name: "Contra:Chargebacks" },
  discounts_account: { value: "9", name: "Contra:Discounts" },
  shipping_income: { value: "10", name: "Other Income:Shipping" },
  sales_tax_payable: { value: "11", name: "Sales Tax Payable" },
  shopify_other_adjustments: { value: "12", name: "Shopify Other Adjustments" },
};

const GATEWAYS = new Map([
  ["shopify_payments", "shopify_payments"],
  ["braintree", "braintree"],
  ["PayPal Braintree", "braintree"],
  ["paypal", "paypal"],
]);

function build(orders: ShopifyOrder[]) {
  return buildJournalEntryLines({
    month: "2026-07",
    orders,
    internalRows: [],
    processors: {},
    acct: ACCT,
    gatewayLookup: GATEWAYS,
    shopifyMappingLookup: new Map(),
    productLookup: new Map(),
    shippingProtectionIds: new Set(),
  } as unknown as JournalEntryInputs);
}

const debitTo = (lines: { posting: string; accountName: string; amount: number }[], name: string) =>
  lines.filter((l) => l.posting === "Debit" && l.accountName === name).reduce((a, l) => a + l.amount, 0);

/** The real SC134526 shape: three gateways listed, one captured everything. */
const SC134526: ShopifyOrder = {
  total_price: 263.51,
  payment_gateway_names: ["braintree", "shopify_payments", "PayPal Braintree"],
  financial_status: "paid",
  line_items: [],
};

test("actual captured amounts win over the equal split", () => {
  const { lines } = build([{ ...SC134526, gateway_amounts: { shopify_payments: 263.51 } }]);
  assert.equal(debitTo(lines, "Clearing:Shopify"), 263.51, "all of it belongs to the capturing gateway");
  assert.equal(debitTo(lines, "Clearing:Braintree"), 0, "a gateway that captured nothing gets nothing");
});

test("without the breakdown it falls back to the equal split — the documented wrong answer", () => {
  const { lines } = build([SC134526]);
  // 263.51 / 3 = 87.836..; braintree and PayPal Braintree BOTH map to braintree, so it gets 2/3.
  assert.ok(Math.abs(debitTo(lines, "Clearing:Shopify") - 87.84) < 0.02);
  assert.ok(Math.abs(debitTo(lines, "Clearing:Braintree") - 175.67) < 0.02, "the fallback invents $175.67 of Braintree clearing");
});

test("an uneven real split is honoured exactly", () => {
  // SC134714: store credit $48.77 + shopify_payments $119.04 on a $167.81 order.
  const { lines } = build([
    {
      total_price: 167.81,
      payment_gateway_names: ["shopify_store_credit", "shopify_payments"],
      financial_status: "paid",
      line_items: [],
      gateway_amounts: { shopify_store_credit: 48.77, shopify_payments: 119.04 },
    },
  ]);
  assert.equal(debitTo(lines, "Clearing:Shopify"), 119.04);
  // store credit is unmapped in this fixture → falls to the "other adjustments" plug
  assert.equal(debitTo(lines, "Shopify Other Adjustments"), 48.77);
});

test("single-gateway orders are unaffected by the change", () => {
  const single: ShopifyOrder = {
    total_price: 100,
    payment_gateway_names: ["shopify_payments"],
    financial_status: "paid",
    line_items: [],
  };
  assert.equal(debitTo(build([single]).lines, "Clearing:Shopify"), 100);
  assert.equal(debitTo(build([{ ...single, gateway_amounts: { shopify_payments: 100 } }]).lines, "Clearing:Shopify"), 100);
});

test("two gateways mapping to the SAME processor accumulate rather than overwrite", () => {
  const { lines } = build([
    {
      total_price: 137.25,
      payment_gateway_names: ["braintree", "PayPal Braintree"],
      financial_status: "paid",
      line_items: [],
      gateway_amounts: { braintree: 37.25, "PayPal Braintree": 100 },
    },
  ]);
  assert.equal(debitTo(lines, "Clearing:Braintree"), 137.25);
});
