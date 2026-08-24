/**
 * Ship-time backfill: null `next_billing_date` on every `public.subscriptions` row where
 * `status = 'cancelled'` AND `next_billing_date IS NOT NULL`.
 *
 * Phase 1 fixed the writers ([[../src/lib/internal-subscription]]
 * `internalSubscriptionAction`, [[../src/lib/appstle]] `appstleSubscriptionAction`,
 * [[../src/lib/inngest/internal-dunning]] `exhaustInternalDunning`, the
 * [[../src/lib/inngest/journey-outcomes]] cancel fallback, and the Appstle webhook
 * upsert) so every FUTURE cancel clears the column in the same update. This backfill is
 * Phase 2 — the already-stale rows that still carry a phantom future (or long-past) date.
 *
 * Ground truth: ticket 8af43dd1 (Bonnie Marlette, 2026-08-24). The CS director escalated
 * a cancelled subscription that still advertised a next-charge on 2026-09-11 (subscription
 * `7b8a5b95…`) and a sibling cancelled row carrying a `next_billing_date` from 2025-10-01
 * (`85044086…`). Every renewal had in fact billed while the sub was still active; the
 * leftover `next_billing_date` column is what made the director think a live charge was
 * coming and ask for a $209.13 refund.
 *
 * Fix at the write, NOT at the readers ([[../docs/brain/lifecycles/subscription-billing]]
 * § "Cancelling — clear the next-billing date at the write"). The readers that consume the
 * column verbatim are: the CS director brief, the founder escalation card, the portal
 * subscription detail page, and the agent context panel.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` (writes a `pending` row to `public.data_op_runs` and
 * escalates any un-run row to the CEO inbox); the box worker's ship-time backfill executor
 * ([[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`) runs it and
 * flips the row to `ran` / `failed` on completion.
 *
 * Idempotent by construction — a compare-and-set update filters on
 * `status = 'cancelled'` AND `next_billing_date IS NOT NULL`, so a re-run finds zero rows
 * (every previously-affected row now carries `next_billing_date = NULL` and no longer
 * matches). A concurrent cancel writer (Phase 1) that lands between our read and our write
 * only affects rows we haven't cursored to yet — the CAS on the same predicate blocks any
 * double-write.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-cancelled-subscription-next-billing-date.ts            # dry-run
 *   npx tsx scripts/_backfill-cancelled-subscription-next-billing-date.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 500;

interface Row {
  id: string;
  workspace_id: string;
  next_billing_date: string | null;
}

(async () => {
  const admin = createAdminClient();

  console.log(`cancelled_subscription_next_billing_date_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(
    `  matching: subscriptions where status='cancelled' AND next_billing_date IS NOT NULL\n`,
  );

  // Cursor-paginated read of every cancelled sub still carrying a next_billing_date.
  // Ordered by `id` for a stable cursor across chunks even if new rows land mid-scan.
  let cursor: string | null = null;
  let scanned = 0;
  let cleared = 0;
  let racedByCas = 0;

  for (;;) {
    let q = admin
      .from("subscriptions")
      .select("id, workspace_id, next_billing_date")
      .eq("status", "cancelled")
      .not("next_billing_date", "is", null)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`select failed: ${error.message}`);

    const chunk = (data ?? []) as Row[];
    if (!chunk.length) break;

    for (const row of chunk) {
      scanned++;

      if (!APPLY) {
        console.log(
          `  would-clear sub=${row.id} workspace=${row.workspace_id} was=${row.next_billing_date}`,
        );
        continue;
      }

      // Compare-and-set: re-assert `status = 'cancelled'` AND `next_billing_date IS NOT NULL`
      // at write-time so a Phase-1 writer (which now nulls the column) or a manual reactivation
      // that landed between our read and our write can't be clobbered. `.select("id")` asserts
      // exactly one row transitioned — zero means raced, never double-executed.
      const { data: upData, error: upErr } = await admin
        .from("subscriptions")
        .update({ next_billing_date: null, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("status", "cancelled")
        .not("next_billing_date", "is", null)
        .select("id");
      if (upErr) throw new Error(`update failed sub=${row.id}: ${upErr.message}`);
      if (!upData?.length) {
        racedByCas++;
        console.log(
          `  raced-by-cas sub=${row.id} workspace=${row.workspace_id} — status or next_billing_date changed between read and write (safe: no overwrite)`,
        );
        continue;
      }
      cleared++;
      console.log(
        `  cleared     sub=${row.id} workspace=${row.workspace_id} was=${row.next_billing_date}`,
      );
    }

    if (chunk.length < CHUNK) break;
    cursor = chunk[chunk.length - 1].id;
  }

  console.log("");
  if (APPLY) {
    console.log(`result: scanned=${scanned} cleared=${cleared} raced-by-cas=${racedByCas}`);
  } else {
    console.log(
      `result: scanned=${scanned} would-clear=${scanned} (dry-run — re-run with --apply to write)`,
    );
  }
})().catch((e) => {
  console.error("ERR", errText(e));
  process.exit(1);
});
