/**
 * Ship-time remediation for ticket `cce7d76b-5736-4d02-b54f-207c93ba984e`
 * (Renea Breashears). Clears the stuck `subscription_cycle_charges` row that
 * wedged internal sub `e4e3b82e...` on `cycle_key=2026-10-04` so her portal
 * order-now and the Oct 4 renewal cron can proceed.
 *
 * Why (spec:
 * failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries):
 * pre-fix `claimCycleCharge` refused ANY different claimant on a 23505
 * conflict regardless of the existing row's status. Renea's Sep 9 Braintree
 * decline resolved as `status='failed'` on `cycle_key=2026-10-04`; dunning
 * then reset `next_billing_date` to the SAME 2026-10-04, so every subsequent
 * portal order-now (new claimant deriving cycle_key from the reset date)
 * collided on the failed row and surfaced `renewal_refused_duplicate_cycle`.
 * The durable fix (same PR) lets `claimCycleCharge` atomically reset+re-own
 * a failed row on conflict; this backfill just proactively clears her stuck
 * row so the Oct 4 cron / a next order-now do not need to depend on the
 * SDK reset to unwedge her.
 *
 * Security posture (Phase 2 — Fix 1). The prior revision of this script
 * scanned `subscription_cycle_charges` by `cycle_key + status` and narrowed
 * by an 8-char subscription_id prefix in memory; the delete's CAS was id +
 * status only. Both were tenant-boundary weak. This revision:
 *   1. RESOLVES the FULL subscription UUID + workspace_id at runtime from
 *      the anchoring artefact (the ticket UUID). The ticket_id is the
 *      spec-authored fact of record — the CS Director's ticket is what
 *      commissioned this remediation, so resolving from it is fail-closed
 *      on the wrong customer even if the code is copy-pasted.
 *   2. VERIFIES the resolved subscription is INTERNAL, is owned by the
 *      ticket's customer_id, sits in the same workspace_id as the ticket,
 *      carries the expected `shopify_contract_id`
 *      (`internal-6d2c9f61c1324cd7`), and its UUID starts with the
 *      spec-cited prefix `e4e3b82e` — any single mismatch throws before
 *      touching the ledger.
 *   3. QUERIES `subscription_cycle_charges` with the FULL predicate:
 *      workspace_id + subscription_id + cycle_key + status, so a
 *      cross-tenant row with any matching axis is never returned.
 *   4. REFUSES the delete if the row carries a non-null `transaction_id`
 *      or `order_id` (a `failed` row with either back-link is not a "no
 *      money moved" row and gets a human).
 *   5. DELETES with a compare-and-set that REPEATS every safety invariant
 *      — `workspace_id`, `subscription_id`, `cycle_key`, `status='failed'`,
 *      `transaction_id IS NULL`, `order_id IS NULL` — plus `.eq('id', …)`
 *      for the specific row. Deleted count must be exactly one OR zero
 *      (CAS-race / already-cleared); anything else throws.
 *
 * The row is DELETED (not updated) because:
 *   - No money moved (status='failed', no successful Braintree sale).
 *   - `transaction_id` / `order_id` are null on this row (verified above).
 *   - The next attempt (portal order-now or cron) writes a fresh
 *     `in_flight` row via `claimCycleCharge` — cleaner than carrying a
 *     zombie failed row.
 *
 * Idempotent by construction:
 *   - Ticket → subscription resolution is deterministic; the full-UUID
 *     query returns 0 rows once the delete lands and the script exits 0.
 *   - A re-run after Renea's next order-now inserted a fresh `in_flight`
 *     (or `succeeded`) row also no-ops because the `status='failed'`
 *     predicate excludes it.
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

// Ground-truth anchors from ticket cce7d76b (CS Director's remediation
// write-up on the CS-Director call). Every value is either the FULL
// identifier we already know, or an unambiguous string constant. The 8-char
// sub prefix is a defence-in-depth check against the RESOLVED sub id — the
// full UUID is derived below.
const TICKET_ID = "cce7d76b-5736-4d02-b54f-207c93ba984e";
const EXPECTED_SHOPIFY_CONTRACT_ID = "internal-6d2c9f61c1324cd7";
const EXPECTED_SUB_ID_PREFIX = "e4e3b82e";
const CYCLE_KEY = "2026-10-04";
const EXPECTED_STATUS = "failed" as const;

(async () => {
  const admin = createAdminClient();

  console.log(
    `renea_cycle_charge_${CYCLE_KEY.replace(/-/g, "_")}_${TICKET_ID.slice(0, 8)}_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  // ── 1. Resolve the ticket → workspace_id + customer_id (full UUIDs). ──
  const { data: ticket, error: ticketErr } = await admin
    .from("tickets")
    .select("id, workspace_id, customer_id")
    .eq("id", TICKET_ID)
    .maybeSingle();
  if (ticketErr) throw new Error(`tickets select failed: ${ticketErr.message}`);
  if (!ticket) throw new Error(`ticket ${TICKET_ID} not found — refuse to guess`);
  if (!ticket.workspace_id || !ticket.customer_id) {
    throw new Error(
      `ticket ${TICKET_ID} is missing workspace_id (${ticket.workspace_id}) or customer_id (${ticket.customer_id})`,
    );
  }
  const EXPECTED_WORKSPACE_ID = String(ticket.workspace_id);
  const EXPECTED_CUSTOMER_ID = String(ticket.customer_id);
  console.log(
    `  ticket resolved: workspace=${EXPECTED_WORKSPACE_ID} customer=${EXPECTED_CUSTOMER_ID}`,
  );

  // ── 2. Resolve the subscription → FULL sub UUID + verified workspace. ──
  // Uniquely identified by (workspace_id + shopify_contract_id) — the spec
  // cites contract `internal-6d2c9f61c1324cd7`. We additionally require the
  // sub to belong to the ticket's customer AND be an internal sub (matches
  // the wedge's ground truth in the spec problem statement).
  const { data: sub, error: subErr } = await admin
    .from("subscriptions")
    .select("id, workspace_id, customer_id, shopify_contract_id, is_internal, status, next_billing_date")
    .eq("workspace_id", EXPECTED_WORKSPACE_ID)
    .eq("shopify_contract_id", EXPECTED_SHOPIFY_CONTRACT_ID)
    .maybeSingle();
  if (subErr) throw new Error(`subscriptions select failed: ${subErr.message}`);
  if (!sub) {
    throw new Error(
      `subscription workspace=${EXPECTED_WORKSPACE_ID} contract=${EXPECTED_SHOPIFY_CONTRACT_ID} not found — refuse to guess`,
    );
  }
  if (!sub.is_internal) {
    throw new Error(
      `sub ${sub.id} is not internal (is_internal=${sub.is_internal}) — refuse to touch a non-internal sub's cycle ledger`,
    );
  }
  if (String(sub.customer_id) !== EXPECTED_CUSTOMER_ID) {
    throw new Error(
      `sub ${sub.id} customer=${sub.customer_id} does not match ticket customer=${EXPECTED_CUSTOMER_ID} — refuse cross-customer remediation`,
    );
  }
  if (String(sub.workspace_id) !== EXPECTED_WORKSPACE_ID) {
    throw new Error(
      `sub ${sub.id} workspace=${sub.workspace_id} does not match ticket workspace=${EXPECTED_WORKSPACE_ID} — refuse cross-workspace remediation`,
    );
  }
  const EXPECTED_SUBSCRIPTION_ID = String(sub.id);
  if (!EXPECTED_SUBSCRIPTION_ID.startsWith(EXPECTED_SUB_ID_PREFIX)) {
    throw new Error(
      `resolved sub id=${EXPECTED_SUBSCRIPTION_ID} does not start with the spec-cited prefix ${EXPECTED_SUB_ID_PREFIX} — refuse (a mismatched prefix means we would remediate the wrong sub)`,
    );
  }
  console.log(
    `  sub resolved: id=${EXPECTED_SUBSCRIPTION_ID} contract=${sub.shopify_contract_id} status=${sub.status} next_billing_date=${sub.next_billing_date}`,
  );

  // ── 3. Full-predicate lookup on the cycle-charges ledger. ──
  // Every axis (workspace + sub + cycle + status) is a FULL value — no
  // cross-tenant row can match, no prefix in-memory filter is used.
  const { data: rows, error } = await admin
    .from("subscription_cycle_charges")
    .select(
      "id, workspace_id, subscription_id, cycle_key, status, amount_cents, claimant, source, transaction_id, order_id, claimed_at, resolved_at",
    )
    .eq("workspace_id", EXPECTED_WORKSPACE_ID)
    .eq("subscription_id", EXPECTED_SUBSCRIPTION_ID)
    .eq("cycle_key", CYCLE_KEY)
    .eq("status", EXPECTED_STATUS);
  if (error) throw new Error(`subscription_cycle_charges select failed: ${error.message}`);

  const matched = rows ?? [];
  if (matched.length > 1) {
    // The unique index on (subscription_id, cycle_key) makes this impossible
    // in practice, but fail-closed if it ever fires — never guess.
    throw new Error(
      `subscription_cycle_charges: ${matched.length} rows matched full predicate — refuse to guess`,
    );
  }
  const row = matched[0] ?? null;

  if (!row) {
    console.log(
      `  no matching row for workspace=${EXPECTED_WORKSPACE_ID} sub=${EXPECTED_SUBSCRIPTION_ID} cycle=${CYCLE_KEY} status=${EXPECTED_STATUS} — already cleared (idempotent no-op)`,
    );
    console.log("");
    console.log(APPLY ? "result: applied (nothing to do)" : "result: dry-run (nothing to do)");
    return;
  }

  console.log(
    `  found row id=${row.id} claimant=${row.claimant} amount=${row.amount_cents} claimed_at=${row.claimed_at} resolved_at=${row.resolved_at} tx=${row.transaction_id} order=${row.order_id}`,
  );

  // ── 4. Refuse if any back-link exists — a `failed` row with a linked
  //       transaction/order is NOT a no-money-moved row and needs a human.
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

  // ── 5. Compare-and-set delete — repeats every safety invariant so a
  //       concurrent SDK reset (failed → in_flight via claimCycleCharge)
  //       between our read and our delete leaves the row alone.
  const { data: deleted, error: delErr } = await admin
    .from("subscription_cycle_charges")
    .delete()
    .eq("id", row.id)
    .eq("workspace_id", EXPECTED_WORKSPACE_ID)
    .eq("subscription_id", EXPECTED_SUBSCRIPTION_ID)
    .eq("cycle_key", CYCLE_KEY)
    .eq("status", EXPECTED_STATUS)
    .is("transaction_id", null)
    .is("order_id", null)
    .select("id");
  if (delErr) throw new Error(`subscription_cycle_charges delete failed: ${delErr.message}`);
  const deletedCount = Array.isArray(deleted) ? deleted.length : 0;
  if (deletedCount === 0) {
    console.log(
      `  raced-by-cas row id=${row.id} — a safety-invariant changed between read and delete (safe: no overwrite; re-run picks up the winner)`,
    );
  } else if (deletedCount === 1) {
    console.log(
      `  deleted  row id=${row.id} — next portal order-now / Oct 4 renewal cron will insert a fresh in_flight claim`,
    );
  } else {
    throw new Error(
      `subscription_cycle_charges delete returned ${deletedCount} rows — refuse to accept ambiguous outcome`,
    );
  }

  console.log("");
  console.log("result: applied");
})().catch((e) => {
  console.error("ERR", errText(e));
  process.exit(1);
});
