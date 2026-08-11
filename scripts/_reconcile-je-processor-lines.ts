import * as fs from "fs";
import { buildProcessorDeductionLines, type AcctMap, type ProcessorSummary } from "../src/lib/qb-close/journal-entry";
const DIR = "fixtures/shoptics-golden";

// account map from the ported golden qb_account_mappings
const amRows = JSON.parse(fs.readFileSync(`${DIR}/qb_account_mappings.json`, "utf8"));
const acct: AcctMap = {}; for (const r of amRows) acct[r.key] = { value: String(r.qb_id), name: r.qb_name };
const pps = JSON.parse(fs.readFileSync(`${DIR}/payment_processor_summaries.json`, "utf8"));
const closes = JSON.parse(fs.readFileSync(`${DIR}/month_end_closings.json`, "utf8"));

// integer-cents aggregate keyed by posting:account (per-processor golden lines that
// share an account — refunds 146, chargebacks 58 — sum here, matching shadow's aggregate).
const agg = (lines: { amount: number; posting: string; accountId: string }[]) => {
  const m = new Map<string, number>();
  for (const l of lines) { const k = `${l.posting}:${l.accountId}`; m.set(k, (m.get(k) ?? 0) + Math.round(l.amount * 100)); }
  return m;
};

let allOk = true;
console.log("Reconciling shadow processor-deduction lines vs actual posted golden JE (per-penny):\n");
for (const c of closes) {
  const month = c.closing_month;
  const sums: ProcessorSummary[] = pps.filter((p: any) => p.closing_month === month)
    .map((p: any) => ({ processor: p.processor, processing_fees: +p.processing_fees, refunds: +p.refunds, chargebacks: +p.chargebacks }));
  const shadow = buildProcessorDeductionLines(sums, acct);
  const sAgg = agg(shadow);

  // golden JE — all journal lines, aggregated by posting:account
  const jeFile = JSON.parse(fs.readFileSync(`${DIR}/qbo-entries/${month}.json`, "utf8"));
  const jeKey = Object.keys(jeFile).find((k) => k.startsWith("journalentry_"))!;
  const je = jeFile[jeKey].JournalEntry ?? jeFile[jeKey];
  const goldenLines = (je.Line || []).filter((l: any) => l.JournalEntryLineDetail).map((l: any) => ({
    amount: l.Amount, posting: l.JournalEntryLineDetail.PostingType, accountId: l.JournalEntryLineDetail.AccountRef.value,
  }));
  const gAgg = agg(goldenLines);

  // Reconciliation claim for THIS slice: every (posting:account) the shadow produces
  // matches the golden JE's aggregate to the penny. (Deposit-side Debits to the clearing
  // accounts belong to the revenue/deposit block — a later slice — so they're not asserted here.)
  const diffs: string[] = [];
  for (const [k, s] of sAgg) { const g = gAgg.get(k) ?? 0; if (s !== g) diffs.push(`${k}: shadow ${(s / 100).toFixed(2)} vs golden ${(g / 100).toFixed(2)}`); }
  const ok = diffs.length === 0; allOk = allOk && ok;
  const covered = [...sAgg.keys()].map((k) => `${(sAgg.get(k)! / 100).toFixed(2)}@${k}`).length;
  console.log(`  ${month}: ${sums.length} processors → ${shadow.length} lines (${covered} acct/posting keys) — ${ok ? "✓ $0.00 variance" : "✗ " + diffs.join("; ")}`);
}
console.log(allOk
  ? "\n✅ ALL 4 MONTHS: shadow processor-deduction lines reconcile to $0.00 vs actual posted QBO."
  : "\n✗ variance found — not reconciled.");
process.exit(allOk ? 0 : 1);
