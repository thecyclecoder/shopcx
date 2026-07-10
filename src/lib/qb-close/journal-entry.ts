// Shoptics → ShopCX migration, Phase 2 (shadow). Reimplementation of the
// month-end Shopify Journal Entry's PROCESSOR lines — the fees / refunds /
// chargebacks / clearing-net-down block that derives purely from
// payment_processor_summaries + qb_account_mappings (no live API needed).
// Ported verbatim from Shoptics api/qb/journal-entry/route.ts buildJournalEntryData.
// SHADOW ONLY — builds line objects, never posts to QuickBooks.
// See docs/brain/lifecycles/shoptics-migration.md.

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface AcctRef { value: string; name: string }
export type AcctMap = Record<string, AcctRef>; // key -> {qb_id, qb_name}

export interface ProcessorSummary {
  processor: string; // 'shopify_payments' | 'paypal' | 'braintree' | ...
  processing_fees: number;
  refunds: number;
  chargebacks: number;
}

export interface JeLine {
  amount: number;
  posting: "Debit" | "Credit";
  accountId: string;
  accountName: string;
  description: string;
}

// Processor → the account-mapping keys for its clearing + txn-fee accounts.
const PROCESSOR_KEYS: Record<string, { clearing: string; fees: string }> = {
  shopify_payments: { clearing: "shopify_clearing", fees: "shopify_txn_fees" },
  paypal: { clearing: "paypal_clearing", fees: "paypal_txn_fees" },
  braintree: { clearing: "braintree_clearing", fees: "braintree_txn_fees" },
};

/**
 * Build the per-processor deduction lines exactly as Shoptics does: for each
 * processor with a summary, Debit its txn-fee / refunds / chargebacks accounts,
 * then Credit its clearing account by the summed deductions (net-down). Amounts
 * are round2; zero lines are omitted (matches Shoptics' `if (x > 0)` guards).
 */
export function buildProcessorDeductionLines(summaries: ProcessorSummary[], acct: AcctMap): JeLine[] {
  const lines: JeLine[] = [];
  const ref = (key: string): AcctRef => acct[key] ?? { value: "", name: `<missing:${key}>` };
  for (const s of summaries) {
    const keys = PROCESSOR_KEYS[s.processor];
    if (!keys) continue; // walmart/gift_card/other handled elsewhere (gross-side)
    const fees = round2(s.processing_fees || 0);
    const refunds = round2(s.refunds || 0);
    const chargebacks = round2(s.chargebacks || 0);
    if (fees > 0) {
      const a = ref(keys.fees);
      lines.push({ amount: fees, posting: "Debit", accountId: a.value, accountName: a.name, description: `${s.processor} transaction fees` });
    }
    if (refunds > 0) {
      const a = ref("refunds_account");
      lines.push({ amount: refunds, posting: "Debit", accountId: a.value, accountName: a.name, description: `${s.processor} refunds` });
    }
    if (chargebacks > 0) {
      const a = ref("chargebacks_account");
      lines.push({ amount: chargebacks, posting: "Debit", accountId: a.value, accountName: a.name, description: `${s.processor} chargebacks` });
    }
    const deductions = round2(fees + refunds + chargebacks);
    if (deductions > 0) {
      const a = ref(keys.clearing);
      lines.push({ amount: deductions, posting: "Credit", accountId: a.value, accountName: a.name, description: `${s.processor} clearing deductions` });
    }
  }
  return lines;
}

/** The realm-specific DEFAULTS ported from Shoptics lib/qb-mappings.ts — used when
 *  a qb_account_mappings row is absent. */
export const QB_ACCOUNT_DEFAULTS: AcctMap = {
  shrinkage_account: { value: "175", name: "Product Costs:Inventory Shrinkage" },
  amazon_customer: { value: "40", name: "Amazon" },
  shopify_customer: { value: "30410", name: "Shopify" },
  amazon_deposit_account: { value: "117", name: "Amazon Carried Balances" },
  shopify_deposit_account: { value: "589", name: "Shopify" },
};

// ─────────────────────────────────────────────────────────────────────────────
// FULL month-end Shopify JournalEntry builder — ported verbatim from Shoptics
// api/qb/journal-entry/route.ts buildJournalEntryData (the whole accrual JE:
// revenue-by-account + shipping + tax − discounts, per-processor gross/fees/
// refunds/chargebacks/clearing, the internal self-balancing block, and the ≤$1
// rounding plug). Pure function: EVERY input is passed in — the live Shopify
// Orders fetch, the internal_sales_snapshots read, and the processor summaries
// all happen at the call site, so this stays shadow-safe and offline-testable.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShopifyOrderLine { price?: string | number; quantity?: number; product_id?: number | string; variant_id?: number | string; }
export interface ShopifyOrder {
  total_shipping_price_set?: { shop_money?: { amount?: string | number } };
  total_tax?: string | number;
  total_discounts?: string | number;
  total_price?: string | number;
  payment_gateway_names?: string[];
  line_items?: ShopifyOrderLine[];
  financial_status?: string;
}
export interface InternalSalesRow {
  product_id: string | null;
  gross_cents: number | null;
  order_total_cents: number | null;
  tax_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  line_index: number | null;
}
export interface ProcessorTotals { gross: number; fees: number; refunds: number; chargebacks: number; adjustments: number; }
export interface RevAcct { name: string; rev_acct_id: string | null; rev_acct_name: string | null; }

export interface JournalEntryInputs {
  month: string; // 'YYYY-MM'
  orders: ShopifyOrder[]; // already filtered to paid | partially_refunded | refunded
  internalRows: InternalSalesRow[];
  processors: Record<string, ProcessorTotals>;
  acct: AcctMap; // keyed by account-mapping key → {value:qb_id, name:qb_name}
  gatewayLookup: Map<string, string>; // gateway_name → processor
  shopifyMappingLookup: Map<string, string>; // `${product_id}-${variant_id}` → qb product id
  productLookup: Map<string, RevAcct>; // qb product id → revenue account
  shippingProtectionIds: Set<string>; // shopify product_id → reclassify revenue to shipping
}

export interface JournalEntryResult { lines: JeLine[]; warnings: string[]; totalDebits: number; totalCredits: number; }

/** Build the full month-end Shopify JournalEntry lines. Faithful port — same order,
 *  same round2 points, same zero-guards, same rounding plug — of Shoptics'
 *  buildJournalEntryData. Posts nothing. */
export function buildJournalEntryLines(inp: JournalEntryInputs): JournalEntryResult {
  const { month, orders, internalRows, processors, acct, gatewayLookup, shopifyMappingLookup, productLookup, shippingProtectionIds } = inp;
  const warnings: string[] = [];
  const m = (key: string): AcctRef => acct[key] ?? { value: "", name: `<missing:${key}>` };

  // ── Shopify orders → revenue by account + gross by processor ──
  const revenueByAccount = new Map<string, { id: string; name: string; amount: number }>();
  const grossByProcessor = new Map<string, number>();
  let totalShipping = 0, totalTax = 0, totalDiscounts = 0, unmappedRevenue = 0;
  for (const order of orders) {
    totalShipping += Number(order.total_shipping_price_set?.shop_money?.amount || 0);
    totalTax += Number(order.total_tax || 0);
    totalDiscounts += Number(order.total_discounts || 0);
    const gateways = (order.payment_gateway_names || []) as string[];
    const orderTotal = Number(order.total_price || 0);
    const perGateway = gateways.length > 0 ? orderTotal / gateways.length : 0;
    for (const gw of gateways) {
      const processor = gatewayLookup.get(gw) || "other";
      grossByProcessor.set(processor, (grossByProcessor.get(processor) || 0) + perGateway);
    }
    for (const item of order.line_items || []) {
      const lineRevenue = Number(item.price || 0) * (item.quantity || 1);
      if (shippingProtectionIds.has(String(item.product_id))) { totalShipping += lineRevenue; continue; }
      const variantKey = `${item.product_id}-${item.variant_id}`;
      const productId = shopifyMappingLookup.get(variantKey);
      const product = productId ? productLookup.get(productId) : null;
      if (product?.rev_acct_id && product?.rev_acct_name) {
        const ex = revenueByAccount.get(product.rev_acct_id) || { id: product.rev_acct_id, name: product.rev_acct_name, amount: 0 };
        ex.amount += lineRevenue;
        revenueByAccount.set(product.rev_acct_id, ex);
      } else unmappedRevenue += lineRevenue;
    }
  }

  // ── Internal (shopcx) orders (from internal_sales_snapshots) ──
  const internalRevenueByAccount = new Map<string, { id: string; name: string; amount: number }>();
  let internalUnmappedRevenue = 0, internalShipping = 0, internalTax = 0, internalDiscount = 0, internalGross = 0, internalOrderCount = 0;
  for (const r of internalRows) {
    const gross = Number(r.gross_cents || 0) / 100;
    if (gross > 0) {
      const product = r.product_id ? productLookup.get(r.product_id) : null;
      if (product?.rev_acct_id && product?.rev_acct_name) {
        const ex = internalRevenueByAccount.get(product.rev_acct_id) || { id: product.rev_acct_id, name: product.rev_acct_name, amount: 0 };
        ex.amount += gross;
        internalRevenueByAccount.set(product.rev_acct_id, ex);
      } else internalUnmappedRevenue += gross;
    }
    if (r.line_index === 0) {
      internalOrderCount++;
      internalTax += Number(r.tax_cents || 0) / 100;
      internalDiscount += Number(r.discount_cents || 0) / 100;
      internalShipping += Number(r.shipping_cents || 0) / 100;
      internalGross += Number(r.order_total_cents || 0) / 100;
    }
  }
  if (internalUnmappedRevenue > 0) warnings.push(`$${round2(internalUnmappedRevenue).toFixed(2)} internal revenue had no product revenue account`);

  const lines: JeLine[] = [];
  const push = (posting: "Debit" | "Credit", a: AcctRef, amount: number, description: string) =>
    lines.push({ amount, posting, accountId: a.value, accountName: a.name, description });

  // ── CREDIT side (revenue) ──
  for (const [, a] of revenueByAccount) if (a.amount > 0) push("Credit", { value: a.id, name: a.name }, round2(a.amount), `${a.name} - ${month}`);
  if (totalShipping > 0) push("Credit", m("shipping_income"), round2(totalShipping), `Shipping Income - ${month}`);
  if (totalTax > 0) push("Credit", m("sales_tax_payable"), round2(totalTax), `Sales Tax Collected - ${month}`);
  // ── DEBIT side (contra-revenue) ──
  if (totalDiscounts > 0) push("Debit", m("discounts_account"), round2(totalDiscounts), `Discounts & Coupons - ${month}`);

  // ── Processor lines (gross debit from orders + fees/refunds/chargebacks + net-down credit) ──
  const processorConfigs = [
    { key: "shopify_payments", clearingKey: "shopify_clearing", feeKey: "shopify_txn_fees", label: "Shopify Payments" },
    { key: "paypal", clearingKey: "paypal_clearing", feeKey: "paypal_txn_fees", label: "PayPal" },
    { key: "braintree", clearingKey: "braintree_clearing", feeKey: "braintree_txn_fees", label: "Braintree" },
  ];
  for (const cfg of processorConfigs) {
    const proc = processors[cfg.key] || { gross: 0, fees: 0, refunds: 0, chargebacks: 0, adjustments: 0 };
    const orderGross = round2(grossByProcessor.get(cfg.key) || 0);
    if (orderGross > 0) push("Debit", m(cfg.clearingKey), orderGross, `${cfg.label} deposits - ${month}`);
    if (proc.fees > 0) push("Debit", m(cfg.feeKey), round2(proc.fees), `${cfg.label} transaction fees - ${month}`);
    if (proc.refunds > 0) push("Debit", m("refunds_account"), round2(proc.refunds), `Refunds - ${cfg.label} - ${month}`);
    if (proc.chargebacks > 0) push("Debit", m("chargebacks_account"), round2(proc.chargebacks), `Chargebacks - ${cfg.label} - ${month}`);
    const deductions = round2(proc.fees + proc.refunds + proc.chargebacks);
    if (deductions > 0) push("Credit", m(cfg.clearingKey), deductions, `${cfg.label} deductions - ${month}`);
  }

  // Other gateways from orders (walmart / gift card / other)
  const walmartGross = round2(grossByProcessor.get("walmart") || 0);
  if (walmartGross > 0 && acct["walmart_clearing"]) push("Debit", m("walmart_clearing"), walmartGross, `Walmart deposits - ${month}`);
  const giftCardGross = round2(grossByProcessor.get("gift_card") || 0);
  if (giftCardGross > 0 && acct["gift_card_liability"]) push("Debit", m("gift_card_liability"), giftCardGross, `Gift card redemptions - ${month}`);
  const otherGross = round2(grossByProcessor.get("other") || 0);
  if (otherGross > 0 && acct["shopify_other_adjustments"]) push("Debit", m("shopify_other_adjustments"), otherGross, `Other payment methods - ${month}`);

  // ── Internal self-balancing block ──
  for (const [, a] of internalRevenueByAccount) if (a.amount > 0) push("Credit", { value: a.id, name: a.name }, round2(a.amount), `${a.name} - Internal - ${month}`);
  if (internalShipping > 0) push("Credit", m("shipping_income"), round2(internalShipping), `Shipping Income - Internal - ${month}`);
  if (internalTax > 0) push("Credit", m("sales_tax_payable"), round2(internalTax), `Sales Tax Collected - Internal - ${month}`);
  if (internalDiscount > 0) push("Debit", m("discounts_account"), round2(internalDiscount), `Discounts & Coupons - Internal - ${month}`);
  if (round2(internalGross) > 0 && acct["internal_deposit_account"]) push("Debit", m("internal_deposit_account"), round2(internalGross), `Internal deposits - ${month}`);
  else if (round2(internalGross) > 0) warnings.push("Internal orders present but no internal_deposit_account mapping — JE will not balance");

  // ── Rounding plug (≤$1) to shopify_other_adjustments ──
  const totalDebits0 = lines.filter((l) => l.posting === "Debit").reduce((s, l) => s + l.amount, 0);
  const totalCredits0 = lines.filter((l) => l.posting === "Credit").reduce((s, l) => s + l.amount, 0);
  const balanceDiff = round2(totalDebits0 - totalCredits0);
  if (balanceDiff !== 0 && Math.abs(balanceDiff) <= 1) {
    push(balanceDiff > 0 ? "Credit" : "Debit", m("shopify_other_adjustments"), Math.abs(balanceDiff), `Rounding adjustment - ${month}`);
  }
  if (unmappedRevenue > 0) warnings.push(`$${unmappedRevenue.toFixed(2)} in revenue from unmapped Shopify products`);
  void internalOrderCount;

  const totalDebits = round2(lines.filter((l) => l.posting === "Debit").reduce((s, l) => s + l.amount, 0));
  const totalCredits = round2(lines.filter((l) => l.posting === "Credit").reduce((s, l) => s + l.amount, 0));
  return { lines, warnings, totalDebits, totalCredits };
}
