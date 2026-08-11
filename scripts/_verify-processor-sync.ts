/**
 * NON-DESTRUCTIVE reconciliation of the processor syncs against the golden July figures.
 *
 * Runs each sync, compares, then RESTORES the prior rows. Two earlier validation passes
 * overwrote known-good backfilled values with unreconciled ones; a read-only check is not
 * possible because the syncs write, so this snapshots and rolls back instead.
 *
 * Usage: npx tsx scripts/_verify-processor-sync.ts 2026-07
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { syncProcessorSummaries } from "../src/lib/qb-close/sync-processors";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const MONTH = process.argv[2] || "2026-07";

const GOLDEN: Record<string, { gross: number; fees: number; refunds: number; chargebacks: number }> = {
  shopify_payments: { gross: 157458.33, fees: 4172.3, refunds: 3369.89, chargebacks: 3083.27 },
  paypal: { gross: 31166.36, fees: 1001.92, refunds: 335.38, chargebacks: 0 },
  braintree: { gross: 20320.61, fees: 313.27, refunds: 576.78, chargebacks: 0 },
};

const d = (a: number, b: number) => {
  const diff = Math.round((a - b) * 100) / 100;
  const pct = b === 0 ? (diff === 0 ? 0 : Infinity) : (diff / b) * 100;
  return `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}${Number.isFinite(pct) ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : ""}`;
};

async function main() {
  const admin = createAdminClient();

  const { data: before } = await admin
    .from("qb_payment_processor_summaries").select("*").eq("workspace_id", WS).eq("closing_month", MONTH);
  console.log(`snapshotted ${before?.length ?? 0} existing row(s) for rollback\n`);

  try {
    const results = await syncProcessorSummaries(admin, WS, MONTH);
    console.log(`${"processor".padEnd(18)}${"status".padEnd(9)}${"gross Δ".padStart(20)}${"fees Δ".padStart(18)}${"refunds Δ".padStart(18)}${"cb Δ".padStart(14)}`);
    for (const r of results) {
      const g = GOLDEN[r.processor];
      if (!r.figures || !g) {
        console.log(`${r.processor.padEnd(18)}${r.status.padEnd(9)}  ${r.detail ?? ""}`.slice(0, 150));
        continue;
      }
      console.log(
        r.processor.padEnd(18) + r.status.padEnd(9) +
          d(r.figures.gross_sales, g.gross).padStart(20) +
          d(r.figures.processing_fees, g.fees).padStart(18) +
          d(r.figures.refunds, g.refunds).padStart(18) +
          d(r.figures.chargebacks, g.chargebacks).padStart(14),
      );
    }
  } finally {
    // Roll back to the snapshot so a validation run never leaves bad figures behind.
    if (before?.length) {
      const { error } = await admin.from("qb_payment_processor_summaries").upsert(before, { onConflict: "workspace_id,closing_month,processor" });
      console.log(`\n${error ? "⚠ ROLLBACK FAILED: " + error.message : "✓ restored the prior rows"}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
