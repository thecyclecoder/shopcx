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
import { pgClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");

// The set of storefront orders that still need the backfill. Same predicate
// the old per-row `needsBackfill()` applied, expressed once in SQL:
//   source_name='storefront'
//   AND discount_codes is empty/[]                       (jsonb_array_length … = 0)
//   AND payment_details.discount_code is a non-empty str (matches `code ? … : null`)
const MATCH = `source_name = 'storefront'
    AND jsonb_array_length(coalesce(discount_codes, '[]'::jsonb)) = 0
    AND coalesce(payment_details->>'discount_code', '') <> ''`;

async function main() {
  const pg = pgClient();
  await pg.connect();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log("Scanning storefront orders for missing discount_codes...\n");

  try {
    const { rows: countRows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE ${MATCH}`,
    );
    const toFix = Number(countRows[0]?.n ?? 0);

    // Samples for operator visibility (same shape as the old dry-run log).
    const { rows: samples } = await pg.query<{
      order_number: string | null;
      id: string;
      code: string;
      discount_cents: number | null;
    }>(
      `SELECT order_number, id,
              payment_details->>'discount_code' AS code,
              (payment_details->>'discount_cents')::int AS discount_cents
         FROM orders
        WHERE ${MATCH}
        LIMIT 15`,
    );
    for (const s of samples) {
      const amt = s.discount_cents ? `-$${(s.discount_cents / 100).toFixed(2)}` : "?";
      console.log(`  #${s.order_number || s.id.slice(0, 8)} → discount_codes = [${s.code}] (${amt})`);
    }
    if (toFix > samples.length) console.log(`  ... and ${toFix - samples.length} more`);

    let fixed = 0;
    if (APPLY) {
      // One set-based, same-row transform. Idempotent (predicate re-checked).
      const res = await pg.query(
        `UPDATE orders
            SET discount_codes = jsonb_build_array(payment_details->>'discount_code')
          WHERE ${MATCH}`,
      );
      fixed = res.rowCount ?? 0;
    }

    console.log(`\n${toFix} storefront orders need discount_codes backfilled from payment_details.discount_code.`);
    if (APPLY) console.log(`✓ Updated ${fixed} orders.`);
    else console.log("\nDry-run only. Re-run with --apply to write.");
  } finally {
    await pg.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
