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
