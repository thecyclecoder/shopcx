/**
 * Backfill the refund ledger from `orders.financial_status='refunded'`.
 *
 * Phase 2 of docs/brain/specs/vendor-side-refunds-must-mirror-into-the-refund-ledger.md.
 *
 * Fixing the ingest path (Phase 1's `refunds/create` webhook +
 * `handleOrderEvent` REST reconcile fallback) captures every refund
 * from the moment it ships. It does NOT close the historical gap:
 * measured 2026-09-11, 28 of 69 fully-refunded orders under-report and
 * $2,429.19 of real refunds are invisible to us — the double-refund
 * guard is blind on every one of them today.
 *
 * This backfill closes that historical gap. For each order whose
 * `financial_status = 'refunded'` (case-insensitive) but whose summed
 * succeeded/settled `order_refunds` are below `total_cents`, insert one
 * mirrored vendor refund for the missing amount:
 *   - vendor = 'shopify' when shopify_order_id is set, 'braintree' otherwise
 *     (the same order-shape rule Phase 1's backfills use).
 *   - vendor_refund_id = null — the order's status is the evidence the
 *     vendor completed the refund, but the specific vendor refund id is
 *     not derivable from the order alone.
 *   - amount_cents = total_cents − existing mirrored sum. Refuse to
 *     write a row that would exceed total_cents (a compare-and-set
 *     against the read-time sum; if the sum grew between read and
 *     write, the ON CONFLICT + gap check protect us).
 *   - request_key = `backfill:financial_status:${order_id}` — stable
 *     per order, so re-running the backfill collides on the
 *     `(order_id, request_key)` unique index and is a no-op (the
 *     SC137733 idempotency proof).
 *   - status = 'settled' (historical refund; already landed).
 *   - source = 'backfill' (the marker from 20260922120000).
 *
 * ONLY `financial_status='refunded'` — a genuine `partially_refunded`
 * order is legitimately below its total, so there is no gap to infer.
 * The `refunded` set is the one with an unambiguous expected value.
 *
 * Dry-run by default. Pass --apply to write.
 *   npx tsx scripts/_backfill-order-refunds-from-financial-status.ts            # dry-run
 *   npx tsx scripts/_backfill-order-refunds-from-financial-status.ts --apply    # write
 *
 * Idempotency proof (per the spec): order SC137733 was reconciled by
 * hand on 2026-09-11. It comes out as a no-op — its ledger sum now
 * matches total_cents, so the decision predicate skips it with
 * `already_covered`.
 */
import { pgClient } from "./_bootstrap";
import {
  decideFinancialStatusBackfill,
  backfillFromFinancialStatusRequestKey,
} from "../src/lib/vendor-refund-mirror";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const INSERT_BATCH = 500;

type OrderRow = {
  order_id: string;
  order_number: string;
  workspace_id: string;
  shopify_order_id: string | null;
  total_cents: number;
  financial_status: string;
  updated_at: Date | null;
  created_at: Date | null;
  mirrored_cents: number | null;
};

type ToInsertRow = {
  order_id: string;
  order_number: string;
  workspace_id: string;
  vendor: "shopify" | "braintree";
  amount_cents: number;
  request_key: string;
  reference_at: Date;
};

async function main(): Promise<void> {
  const c = pgClient();
  await c.connect();
  const t0 = Date.now();
  try {
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`Workspace: ${WS}\n`);

    // Source of truth: orders where financial_status is refunded (case-insensitive)
    // joined against a per-order sum of the ledger's non-failed rows. Only
    // 'succeeded' / 'settled' contribute to the mirrored sum — a 'requested'
    // / 'failed' / 'reversed' row is not evidence the money moved.
    const { rows: raw } = await c.query<OrderRow>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS mirrored_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT
         o.id             AS order_id,
         o.order_number,
         o.workspace_id,
         o.shopify_order_id,
         COALESCE(o.total_cents, 0)::int AS total_cents,
         o.financial_status,
         o.updated_at,
         o.created_at,
         m.mirrored_cents
       FROM public.orders o
       LEFT JOIN mirror m ON m.order_id = o.id
       WHERE o.workspace_id = $1::uuid
         AND LOWER(o.financial_status) = 'refunded'
         AND COALESCE(o.total_cents, 0) > 0
       ORDER BY o.created_at ASC`,
      [WS],
    );

    console.log(`Fully-refunded orders (financial_status='refunded'): ${raw.length}`);

    // Decide per-order via the pure predicate. Everything the script
    // does downstream is a mechanical translation of these verdicts —
    // the predicate is unit-tested (src/lib/vendor-refund-mirror.test.ts).
    const skipReasons: Record<string, number> = {};
    const toInsert: ToInsertRow[] = [];
    for (const r of raw) {
      const decision = decideFinancialStatusBackfill({
        financialStatus: r.financial_status,
        totalCents: r.total_cents,
        mirroredSuccessSettledCents: r.mirrored_cents,
      });
      if (decision.skip) {
        skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
        continue;
      }
      toInsert.push({
        order_id: r.order_id,
        order_number: r.order_number,
        workspace_id: r.workspace_id,
        vendor: r.shopify_order_id ? "shopify" : "braintree",
        amount_cents: decision.gapCents,
        request_key: backfillFromFinancialStatusRequestKey(r.order_id),
        // Historical refund timestamp — best-effort: prefer updated_at
        // (Shopify stamps that on the refund-time flip); fall back to
        // created_at. The row's requested_at + settled_at both land on
        // this value per the returns backfill convention.
        reference_at: r.updated_at ?? r.created_at ?? new Date(0),
      });
    }

    console.log(`\nDecision breakdown:`);
    for (const [reason, count] of Object.entries(skipReasons)) {
      console.log(`  skip:${reason.padEnd(20, " ")} ${count}`);
    }
    console.log(`  insert:                  ${toInsert.length}`);
    const totalGapCents = toInsert.reduce((s, r) => s + r.amount_cents, 0);
    console.log(`\nGap closed by this run: $${(totalGapCents / 100).toFixed(2)}`);

    const byVendor: Record<string, { count: number; cents: number }> = {};
    for (const r of toInsert) {
      const b = (byVendor[r.vendor] ??= { count: 0, cents: 0 });
      b.count++;
      b.cents += r.amount_cents;
    }
    for (const [v, b] of Object.entries(byVendor)) {
      console.log(`  by vendor: ${v.padEnd(10)} count=${b.count} cents=$${(b.cents / 100).toFixed(2)}`);
    }

    if (toInsert.length > 0) {
      console.log(`\nFirst 5 to insert:`);
      for (const r of toInsert.slice(0, 5)) {
        console.log(
          `  order=${r.order_number} amt=$${(r.amount_cents / 100).toFixed(2)} vendor=${r.vendor} ref_at=${r.reference_at.toISOString()}`,
        );
      }
    }

    if (!APPLY) {
      console.log(`\nDry-run only. Re-run with --apply to insert ${toInsert.length} rows.`);
      return;
    }

    if (toInsert.length === 0) {
      console.log(`\n✓ Nothing to insert — every fully-refunded order is already covered.`);
      return;
    }

    // Compare-and-set on the write: the INSERT ... SELECT re-reads the
    // mirrored sum at write time and only lands the row if the gap is
    // STILL positive AND the row cannot push the sum over total_cents.
    // This is the guard-before-mutation the coaching pins (learning
    // #12): a concurrent live-fire mirror (Phase 1's webhook) landing
    // between our read and our write cannot cause an over-refund
    // ledger. The `ON CONFLICT (order_id, request_key) DO NOTHING` is
    // the second-layer backstop against a re-run race.
    let inserted = 0;
    let noopByRace = 0;
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const chunk = toInsert.slice(i, i + INSERT_BATCH);
      for (const r of chunk) {
        const res = await c.query(
          `INSERT INTO public.order_refunds
             (workspace_id, order_id, request_key, vendor, vendor_refund_id,
              amount_cents, status, requested_at, settled_at, source)
           SELECT
             $1::uuid, $2::uuid, $3::text, $4::text, NULL,
             $5::int, 'settled', $6::timestamptz, $6::timestamptz, 'backfill'
           WHERE (
             SELECT COALESCE(SUM(amount_cents), 0)
               FROM public.order_refunds
              WHERE workspace_id = $1::uuid
                AND order_id     = $2::uuid
                AND status IN ('succeeded', 'settled')
           ) + $5::int <= (
             SELECT COALESCE(total_cents, 0)
               FROM public.orders
              WHERE id = $2::uuid AND workspace_id = $1::uuid
           )
           ON CONFLICT (order_id, request_key) DO NOTHING`,
          [
            r.workspace_id,
            r.order_id,
            r.request_key,
            r.vendor,
            r.amount_cents,
            r.reference_at,
          ],
        );
        const rowCount = res.rowCount ?? 0;
        if (rowCount === 1) inserted++;
        else noopByRace++;
      }
      process.stdout.write(`  inserted ${inserted}/${toInsert.length} (raced/skipped: ${noopByRace})\r`);
    }
    console.log(`\n✓ inserted ${inserted} rows (${noopByRace} skipped by guard/race).`);

    // Post-apply verification — count remaining gaps. Success = zero.
    const { rows: verifyRow } = await c.query<{ remaining_gap: number }>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS mirrored_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT COUNT(*)::int AS remaining_gap
         FROM public.orders o
    LEFT JOIN mirror m ON m.order_id = o.id
        WHERE o.workspace_id = $1::uuid
          AND LOWER(o.financial_status) = 'refunded'
          AND COALESCE(o.total_cents, 0) > 0
          AND COALESCE(m.mirrored_cents, 0) < o.total_cents`,
      [WS],
    );
    const remaining = verifyRow[0]?.remaining_gap ?? -1;
    console.log(`\nPost-apply verification: ${remaining} fully-refunded order(s) still under-mirrored.`);
    if (remaining !== 0) {
      console.log(
        `  (Expected 0. A non-zero count is a real drift signal — investigate before re-running.)`,
      );
    }
  } finally {
    await c.end();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nDone in ${dt}s.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
