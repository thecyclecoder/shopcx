/**
 * Backfill: populate orders.discount_codes for existing storefront orders
 * from payment_details.discount_code.
 *
 * Why: storefront checkout historically wrote the applied coupon only into
 * payment_details.{discount_code,discount_cents}, leaving discount_codes = []
 * on 100% of storefront orders. The orchestrator's order context reads
 * discount_codes, so it believed those orders had no discount — the direct
 * cause of the "no discounts applied" misread + agree-and-refund failure
 * (ticket 8e9e325e). Checkout now writes discount_codes going forward; this
 * backfills the historical rows so the AI sees the coupon on old orders too.
 *
 * Match: source_name='storefront' AND discount_codes is empty/[] AND
 * payment_details.discount_code is present. Set discount_codes = [code].
 * Idempotent (re-running skips rows already populated) and resumable
 * (cursor-paginated by created_at). Defaults to dry-run; pass --apply to write.
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const PAGE = 500;

type OrderRow = {
  id: string;
  order_number: string | null;
  source_name: string | null;
  discount_codes: unknown;
  payment_details: { discount_code?: string | null; discount_cents?: number | null } | null;
  created_at: string;
};

function needsBackfill(o: OrderRow): string | null {
  const existing = Array.isArray(o.discount_codes) ? (o.discount_codes as unknown[]) : [];
  if (existing.length > 0) return null; // already populated — skip (idempotent)
  const code = o.payment_details?.discount_code;
  return code ? String(code) : null;
}

async function main() {
  const admin = createAdminClient();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log("Scanning storefront orders for missing discount_codes...\n");

  let cursor = "1970-01-01T00:00:00Z";
  let scanned = 0;
  let toFix = 0;
  let fixed = 0;
  const samples: string[] = [];

  for (;;) {
    const { data: rows, error } = await admin
      .from("orders")
      .select("id, order_number, source_name, discount_codes, payment_details, created_at")
      .eq("source_name", "storefront")
      .gt("created_at", cursor)
      .order("created_at", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    for (const o of rows as OrderRow[]) {
      scanned++;
      const code = needsBackfill(o);
      if (!code) continue;
      toFix++;
      if (samples.length < 15) {
        samples.push(`  #${o.order_number || o.id.slice(0, 8)} → discount_codes = [${code}] (${o.payment_details?.discount_cents ? `-$${((o.payment_details.discount_cents) / 100).toFixed(2)}` : "?"})`);
      }
      if (APPLY) {
        const { error: upErr } = await admin
          .from("orders")
          .update({ discount_codes: [code] })
          .eq("id", o.id);
        if (upErr) console.log(`  ✗ ${o.order_number || o.id}: ${upErr.message}`);
        else fixed++;
      }
    }
    cursor = (rows[rows.length - 1] as OrderRow).created_at;
    if (rows.length < PAGE) break;
  }

  console.log(samples.join("\n"));
  if (toFix > samples.length) console.log(`  ... and ${toFix - samples.length} more`);
  console.log(`\nScanned ${scanned} storefront orders.`);
  console.log(`${toFix} need discount_codes backfilled from payment_details.discount_code.`);
  if (APPLY) console.log(`✓ Updated ${fixed} orders.`);
  else console.log("\nDry-run only. Re-run with --apply to write.");
}

main().catch((e) => { console.error(e); process.exit(1); });
