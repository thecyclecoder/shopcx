/**
 * Ship-time remediation for ticket `cce7d76b-5736-4d02-b54f-207c93ba984e`
 * (Renea Breashears). Clears the stuck `subscription_cycle_charges` row that
 * wedged internal sub `e4e3b82e` on `cycle_key=2026-10-04` so her portal
 * order-now and the Oct 4 renewal cron can proceed.
 *
 * Why (spec:
 * failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries):
 * pre-fix `claimCycleCharge` refused ANY different claimant on a 23505
 * conflict regardless of the existing row's status. Renea's Sep 9 Braintree
 * decline resolved as `status='failed'` on `cycle_key=2026-10-04`; dunning
 * then reset `next_billing_date` to the SAME 2026-10-04, so every subsequent
 * portal order-now (new claimant deriving cycle_key from the reset date)
 * collided on the failed row and surfaced `renewal_refused_duplicate_cycle`
 * — the customer's "order confirmation screen but no order" symptom. The
 * durable fix (same PR) lets `claimCycleCharge` atomically reset+re-own a
 * failed row on conflict; this backfill just proactively clears her stuck
 * row so the Oct 4 cron / a next order-now do not need to depend on the
 * SDK reset to unwedge her.
 *
 * The row is DELETED (not updated) because:
 *   - No money moved (status='failed', no successful Braintree sale).
 *   - `subscription_cycle_charges` back-links `transaction_id` / `order_id`
 *     are null on this row (nothing to preserve for audit).
 *   - The next attempt (portal order-now or cron) writes a fresh
 *     `in_flight` row via `claimCycleCharge` — cleaner than carrying a
 *     zombie failed row.
 *
 * Idempotent by construction:
 *   - Read-first + strict-single narrowing: sub UUID prefix `e4e3b82e` +
 *     cycle_key '2026-10-04' + status='failed' must resolve to exactly one
 *     row or the script fails-closed via `pickExactlyOne`.
 *   - A re-run after the row has been deleted finds zero matches → logs
 *     'already cleared' and exits 0.
 *   - A re-run after Renea's next order-now inserted a fresh `in_flight`
 *     (or `succeeded`) row still no-ops because the status='failed' filter
 *     excludes it.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` and drained by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default. Pass `--apply` (or `APPLY=1`) to write.
 *
 *   npx tsx scripts/_backfill-renea-cycle-charge-2026-10-04-cce7d76b.ts
 *   npx tsx scripts/_backfill-renea-cycle-charge-2026-10-04-cce7d76b.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

// Ground-truth identifiers from ticket cce7d76b — kept explicit because this
// is a one-customer surgical fix, not a scan. A typo in ANY of the three
// narrows the match set to zero and pickExactlyOne throws.
const TICKET_ID_PREFIX = "cce7d76b";
const SUB_ID_PREFIX = "e4e3b82e";
const CYCLE_KEY = "2026-10-04";
const EXPECTED_STATUS = "failed" as const;

async function pickAtMostOne<T>(
  label: string,
  rows: T[] | null | undefined,
): Promise<T | null> {
  const list = rows ?? [];
  if (list.length === 0) return null;
  if (list.length > 1) throw new Error(`${label}: ${list.length} rows matched — refuse to guess`);
  return list[0]!;
}

(async () => {
  const admin = createAdminClient();

  console.log(
    `renea_cycle_charge_2026_10_04_${TICKET_ID_PREFIX}_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  // Scan by cycle_key + status at the DB, narrow by sub UUID prefix in
  // memory (Postgres has no pattern-match operator for uuid — see spec
  // no-sql-pattern-match-on-a-uuid-column).
  const { data: rows, error } = await admin
    .from("subscription_cycle_charges")
    .select(
      "id, workspace_id, subscription_id, cycle_key, status, amount_cents, claimant, source, transaction_id, order_id, claimed_at, resolved_at",
    )
    .eq("cycle_key", CYCLE_KEY)
    .eq("status", EXPECTED_STATUS);
  if (error) throw new Error(`subscription_cycle_charges select failed: ${error.message}`);

  const narrowed = (rows ?? []).filter(
    (r) => typeof r.subscription_id === "string" && r.subscription_id.startsWith(SUB_ID_PREFIX),
  );
  const row = await pickAtMostOne("subscription_cycle_charges", narrowed);

  if (!row) {
    console.log(
      `  no matching row for sub prefix=${SUB_ID_PREFIX} cycle=${CYCLE_KEY} status=${EXPECTED_STATUS} — already cleared (idempotent no-op)`,
    );
    console.log("");
    console.log(APPLY ? "result: applied (nothing to do)" : "result: dry-run (nothing to do)");
    return;
  }

  console.log(
    `  found row id=${row.id} workspace=${row.workspace_id} subscription=${row.subscription_id} claimant=${row.claimant} amount=${row.amount_cents} claimed_at=${row.claimed_at} resolved_at=${row.resolved_at}`,
  );

  // Refuse-if-non-null — a `failed` row with a back-linked order/transaction
  // means SOMETHING may have moved for it. The 23505 spec explicitly says
  // "A failed claim means no Braintree sale occurred" — but the audit column
  // is the ground truth we check, not the status. Fail-closed if it looks
  // like a real order got attached.
  if (row.transaction_id || row.order_id) {
    throw new Error(
      `refusing to delete: row id=${row.id} has non-null transaction_id=${row.transaction_id} order_id=${row.order_id} — inspect manually`,
    );
  }

  if (!APPLY) {
    console.log(
      `  would-delete row id=${row.id} (status='${EXPECTED_STATUS}', no linked transaction/order — safe to re-open the cycle)`,
    );
    console.log("");
    console.log("result: dry-run — re-run with --apply to write");
    return;
  }

  // Compare-and-set on status: if a concurrent call (e.g. the SDK's failed→in_flight
  // reset landed via a portal order-now between our read and our delete), the row is
  // no longer 'failed' and we MUST NOT delete an in-flight/succeeded row. The status
  // filter narrows the delete to the exact snapshot we read.
  const { data: deleted, error: delErr } = await admin
    .from("subscription_cycle_charges")
    .delete()
    .eq("id", row.id)
    .eq("status", EXPECTED_STATUS)
    .select("id");
  if (delErr) throw new Error(`subscription_cycle_charges delete failed: ${delErr.message}`);
  if (!deleted?.length) {
    console.log(
      `  raced-by-cas row id=${row.id} — status changed between read and delete (safe: no overwrite; re-run picks up the winner)`,
    );
  } else {
    console.log(
      `  deleted  row id=${row.id} — next portal order-now / Oct 4 renewal cron will insert a fresh in_flight claim`,
    );
  }

  console.log("");
  console.log("result: applied");
})().catch((e) => {
  console.error("ERR", errText(e));
  process.exit(1);
});
