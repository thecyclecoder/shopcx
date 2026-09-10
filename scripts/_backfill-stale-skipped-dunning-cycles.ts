/**
 * Backfill: release the dunning slot held by stale `skipped` cycles.
 *
 * ## What went wrong
 *
 * `handleAllCardsExhausted` reads the cards to rotate from `customer_payment_methods`. That
 * mirror's oldest row is 2026-05-20 — but 55 of these 56 cycles were created BEFORE it held any
 * data. So dunning read an empty card list, concluded "all cards exhausted" in a median of 1.11
 * seconds without attempting a single charge, and (because `dunning_cycle_1_action = 'skip'`)
 * wrote `status='skipped'` — then emailed every one of those customers "your payment failed,
 * update your payment method". Sampling 10 against live Shopify, 5 had a valid unrevoked card
 * the whole time.
 *
 * `skipped` is in ACTIVE_SLOT_STATUSES, so it holds `idx_dunning_cycles_active_contract`. The
 * cron therefore returns `active_cycle_exists` forever and can never open cycle 2 — the cycle
 * that would actually resolve them. Only `dunning-new-card-recovery` reopens a `skipped` cycle,
 * and only if the customer adds a card, which none did. They have sat since 2026-03..05: still
 * `status='active'`, a median of 287 days since their last order, invisible to both billing and
 * dunning.
 *
 * ## What this does
 *
 * Drives those cycles to the terminal `exhausted` so the slot frees and a real cycle can open.
 *
 *  - `closed_reason` is set NON-NULL deliberately. `dunning-new-card-recovery` treats
 *    `status='exhausted' AND closed_reason IS NULL` as "dunning gave up" and will REACTIVATE +
 *    CHARGE on a later card update. These customers were never actually charged, were told
 *    otherwise, and are ~287 days dormant — a surprise catch-up charge is the wrong outcome.
 *    A non-null reason opts them out of that path while still freeing the slot.
 *  - `terminal_error_code` is left NULL. The dunning analytics panel counts
 *    `status='exhausted' AND terminal_error_code IS NOT NULL` as a terminal cancellation, and
 *    this was not one. Same reasoning as `endDunningForSubscription`.
 *
 * This does NOT resume billing and does NOT cancel anything. It only removes the block.
 *
 * Idempotent: it selects on `status='skipped'`, which the write clears, so a second run finds 0.
 * Dry-run by default; pass --apply to write.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

const CLOSED_REASON = "stale_skip_no_cards_tried";
/** All 56 were created 2026-03..05; the card mirror's first row is 2026-05-20. */
const STALE_BEFORE = "2026-06-01T00:00:00Z";

async function main() {
  const apply = process.argv.includes("--apply");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { updateDunningCycle } = await import("../src/lib/dunning");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("dunning_cycles")
    .select("id, workspace_id, shopify_contract_id, cycle_number, cards_tried, skipped_at, next_retry_at")
    .eq("status", "skipped")
    .is("next_retry_at", null)
    .lt("skipped_at", STALE_BEFORE);
  if (error) throw new Error(`select failed: ${error.message}`);

  const rows = data ?? [];
  // Guard: only release cycles that genuinely never tried a card. A `skipped` cycle WITH
  // attempts is a different animal and is left alone for a human to look at.
  const target = rows.filter((r) => !Array.isArray(r.cards_tried) || r.cards_tried.length === 0);
  const withCards = rows.length - target.length;

  console.log(`stale 'skipped' cycles (next_retry_at null, skipped before ${STALE_BEFORE.slice(0, 10)}): ${rows.length}`);
  console.log(`  never tried a card -> will release: ${target.length}`);
  console.log(`  HAD cards tried    -> left alone:   ${withCards}`);
  if (!apply) {
    console.log(`\nDRY RUN. Re-run with --apply to write.`);
    target.slice(0, 5).forEach((r) => console.log(`   would release ${r.shopify_contract_id} (cycle ${r.cycle_number})`));
    return;
  }

  let ok = 0;
  for (const r of target) {
    await updateDunningCycle(r.id, {
      status: "exhausted",
      next_retry_at: null,
      closed_reason: CLOSED_REASON,
    });
    ok++;
  }
  console.log(`\nreleased ${ok} cycle(s) -> status='exhausted', closed_reason='${CLOSED_REASON}'`);

  const { count: left } = await admin
    .from("dunning_cycles")
    .select("id", { count: "exact", head: true })
    .eq("status", "skipped")
    .is("next_retry_at", null)
    .lt("skipped_at", STALE_BEFORE);
  console.log(`remaining stale 'skipped' after run: ${left} (expect 0 aside from any left alone above)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
