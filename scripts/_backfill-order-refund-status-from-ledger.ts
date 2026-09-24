/**
 * Backfill `orders.financial_status` from the refund ledger via the
 * ONE writer.
 *
 * Phase 1 of docs/brain/specs/a-braintree-side-refund-must-reach-our-books.md.
 *
 * The spec's Phase 1 extracts `deriveAndSetOrderRefundStatus` out of
 * `refundOrder` so there is ONE writer of `orders.financial_status`
 * from the refund ledger. This script is the reconcile arm: it calls
 * that same routine for every order whose stored status disagrees
 * with its ledger.
 *
 * Runs alongside `scripts/_backfill-order-refunds-from-financial-status.ts`
 * which solves the OPPOSITE direction (a `financial_status='refunded'`
 * with an empty ledger). That backfill cannot catch these rows because
 * it keys off a status that is ALREADY `refunded`; here we key off the
 * ledger itself so the wrong-status set is the one we see.
 *
 * Ground truth on 2026-09-24: 15 orders totalling $1,524.59 carry a
 * correct ledger row and a stale `paid` status. Example SHOPCX373 —
 * its ledger sums to exactly its $140.28 total but the order still
 * reads `paid`. After this run its status is `refunded`.
 *
 * Idempotency: `deriveAndSetOrderRefundStatus` never regresses a
 * stronger vendor-stamped state (weight refunded > partially_refunded
 * > everything else) and only writes when the derived weight is
 * STRICTLY greater than the current stored weight. A row corrected on
 * a prior pass compares equal or greater the second time and is a
 * no-op — the CLAUDE.md ship-time-backfill-must-be-tracked rule's
 * "must be idempotent" clause.
 *
 * Dry-run by default. Pass --apply to write.
 *   npx tsx scripts/_backfill-order-refund-status-from-ledger.ts            # dry-run
 *   npx tsx scripts/_backfill-order-refund-status-from-ledger.ts --apply    # write
 */
import { pgClient } from "./_bootstrap";
import { deriveAndSetOrderRefundStatus } from "../src/lib/refund";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

type CandidateRow = {
  order_id: string;
  order_number: string | null;
  workspace_id: string;
  total_cents: number;
  financial_status: string | null;
  refunded_cents: number;
};

function statusWeight(raw: string | null | undefined): number {
  const s = String(raw ?? "").toLowerCase();
  if (s === "refunded") return 2;
  if (s === "partially_refunded") return 1;
  return 0;
}

function derivedFromLedger(
  totalCents: number,
  refundedCents: number,
): "refunded" | "partially_refunded" | null {
  if (refundedCents <= 0) return null;
  if (totalCents > 0) return refundedCents >= totalCents ? "refunded" : "partially_refunded";
  return "refunded";
}

async function main(): Promise<void> {
  const c = pgClient();
  await c.connect();
  const t0 = Date.now();
  try {
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`Workspace: ${WS}\n`);

    // Every order that carries a positive succeeded/settled ledger sum.
    // Drive off the ledger — a wrong-status row is exactly what we're
    // here to correct, so filtering by the column is illegal.
    const { rows: raw } = await c.query<CandidateRow>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS refunded_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT
         o.id             AS order_id,
         o.order_number,
         o.workspace_id,
         COALESCE(o.total_cents, 0)::int AS total_cents,
         o.financial_status,
         m.refunded_cents
       FROM public.orders o
       JOIN mirror m ON m.order_id = o.id
       WHERE o.workspace_id = $1::uuid
         AND m.refunded_cents > 0
       ORDER BY o.created_at ASC`,
      [WS],
    );

    console.log(`Orders carrying a positive succeeded/settled ledger: ${raw.length}`);

    // Preview the write set using the same predicate the routine uses.
    // The APPLY loop below hands each order to the SDK routine so the
    // decision is made by ONE writer, not this script.
    type Preview = {
      order_id: string;
      order_number: string | null;
      current: string;
      derived: "refunded" | "partially_refunded";
      refunded_cents: number;
      total_cents: number;
    };
    const stale: Preview[] = [];
    const skips: Record<string, number> = {};
    for (const r of raw) {
      const derived = derivedFromLedger(r.total_cents, r.refunded_cents);
      if (!derived) {
        skips.no_positive_ledger = (skips.no_positive_ledger ?? 0) + 1;
        continue;
      }
      const currentWeight = statusWeight(r.financial_status);
      const nextWeight = derived === "refunded" ? 2 : 1;
      if (nextWeight <= currentWeight) {
        const currentLc = String(r.financial_status ?? "").toLowerCase();
        const reason =
          currentLc === derived ? "already_correct" : "stored_stronger_or_equal";
        skips[reason] = (skips[reason] ?? 0) + 1;
        continue;
      }
      stale.push({
        order_id: r.order_id,
        order_number: r.order_number,
        current: String(r.financial_status ?? ""),
        derived,
        refunded_cents: r.refunded_cents,
        total_cents: r.total_cents,
      });
    }

    console.log(`\nDecision breakdown:`);
    for (const [reason, count] of Object.entries(skips)) {
      console.log(`  skip:${reason.padEnd(24, " ")} ${count}`);
    }
    console.log(`  write:${" ".padEnd(24, " ")} ${stale.length}`);

    if (stale.length > 0) {
      console.log(`\nFirst 10 to write:`);
      for (const r of stale.slice(0, 10)) {
        console.log(
          `  order=${r.order_number ?? r.order_id} current=${r.current || "(null)"} → ${r.derived} refunded=$${(r.refunded_cents / 100).toFixed(2)} / total=$${(r.total_cents / 100).toFixed(2)}`,
        );
      }
    }

    if (!APPLY) {
      console.log(`\nDry-run only. Re-run with --apply to write ${stale.length} rows.`);
      return;
    }

    if (stale.length === 0) {
      console.log(`\n✓ Nothing to write — every order's status already matches its ledger.`);
      return;
    }

    // Hand each order to the SDK routine so the write goes through the
    // ONE writer. On a second pass the routine's own weight guard makes
    // this a no-op — the idempotency proof the spec asks for.
    let updated = 0;
    let noop = 0;
    let failed = 0;
    for (const r of stale) {
      const res = await deriveAndSetOrderRefundStatus(WS, r.order_id);
      if (!res.ok) {
        failed++;
        console.error(`  ✗ ${r.order_number ?? r.order_id}: ${res.error}`);
        continue;
      }
      if (res.updated) updated++;
      else noop++;
    }
    console.log(`\n✓ ${updated} updated, ${noop} no-op (already correct on re-read), ${failed} failed.`);

    // Post-apply verification — count remaining disagreements. Success = zero.
    const { rows: verifyRow } = await c.query<{ remaining: number }>(
      `WITH mirror AS (
         SELECT order_id, COALESCE(SUM(amount_cents), 0)::int AS refunded_cents
           FROM public.order_refunds
          WHERE workspace_id = $1::uuid
            AND status IN ('succeeded', 'settled')
          GROUP BY order_id
       )
       SELECT COUNT(*)::int AS remaining
         FROM public.orders o
         JOIN mirror m ON m.order_id = o.id
        WHERE o.workspace_id = $1::uuid
          AND m.refunded_cents > 0
          AND CASE
                WHEN COALESCE(o.total_cents, 0) > 0 AND m.refunded_cents >= o.total_cents THEN 2
                WHEN m.refunded_cents > 0 THEN 1
                ELSE 0
              END
              > CASE LOWER(COALESCE(o.financial_status, ''))
                  WHEN 'refunded' THEN 2
                  WHEN 'partially_refunded' THEN 1
                  ELSE 0
                END`,
      [WS],
    );
    const remaining = verifyRow[0]?.remaining ?? -1;
    console.log(`\nPost-apply verification: ${remaining} order(s) still disagree with their ledger.`);
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
