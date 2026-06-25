/**
 * Backfill: clear `last_payment_status='failed'` on internal subscriptions
 * that have already recovered.
 *
 * Background (escalated ticket efe0d2ad — Annmarie Maruca):
 *   Internal subs (is_internal=true) never fire the Appstle billing-success
 *   webhook that flips subscriptions.last_payment_status back to 'succeeded'.
 *   Before the renewal-success + closeInternalDunningOnSuccess fix landed in
 *   this same PR, every internal sub that experienced a failure stayed
 *   permanently flagged 'failed' even after recovery — locking change-date
 *   (src/lib/portal/handlers/change-date.ts:50) and change-frequency
 *   (src/lib/portal/handlers/frequency.ts:39), and rendering them as
 *   `needsAttention` in the portal.
 *
 * Rows to clear (idempotent — re-running skips already-cleared rows):
 *   - is_internal = true
 *   - status      = 'active'
 *   - last_payment_status = 'failed'
 *   - most-recent dunning_cycles row for the subscription has status='recovered'
 *   - at least one paid order on the subscription with created_at > the
 *     dunning_cycles.recovered_at (proof the recovery actually charged through)
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/backfill-internal-sub-last-payment-status.ts          # dry-run
 *   npx tsx scripts/backfill-internal-sub-last-payment-status.ts --apply  # mutate
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const PAGE_SIZE = 500;
const UPDATE_BATCH = 200;

async function main() {
  const admin = createAdminClient();
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // 1. Page through candidate subs (is_internal + active + last_payment_status='failed').
  //    Cursor-paginate on id so a re-run after a crash naturally resumes.
  const candidates: Array<{ id: string; workspace_id: string; shopify_contract_id: string | null }> = [];
  let lastId: string | null = null;
  while (true) {
    let q = admin
      .from("subscriptions")
      .select("id, workspace_id, shopify_contract_id")
      .eq("is_internal", true)
      .eq("status", "active")
      .eq("last_payment_status", "failed")
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`subscriptions page fetch: ${error.message}`);
    if (!data?.length) break;
    candidates.push(
      ...data.map((r) => ({
        id: r.id as string,
        workspace_id: r.workspace_id as string,
        shopify_contract_id: (r.shopify_contract_id as string | null) ?? null,
      })),
    );
    lastId = data[data.length - 1].id as string;
    if (data.length < PAGE_SIZE) break;
  }
  console.log(`Candidates (internal + active + last_payment_status='failed'): ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // 2. For each candidate, fetch the most-recent dunning_cycles row and confirm
  //    status='recovered'. Then confirm at least one paid order after recovered_at.
  const toClear: Array<{ id: string; recovered_at: string }> = [];
  const skips = { no_cycle: 0, cycle_not_recovered: 0, no_paid_order_after: 0 };

  let inspected = 0;
  for (const sub of candidates) {
    inspected++;
    if (inspected % 50 === 0) {
      process.stdout.write(`  inspected ${inspected}/${candidates.length}\r`);
    }

    const { data: cycle, error: cycleErr } = await admin
      .from("dunning_cycles")
      .select("id, status, recovered_at")
      .eq("subscription_id", sub.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cycleErr) throw new Error(`dunning_cycles fetch for ${sub.id}: ${cycleErr.message}`);
    if (!cycle) { skips.no_cycle++; continue; }
    if (cycle.status !== "recovered") { skips.cycle_not_recovered++; continue; }
    if (!cycle.recovered_at) { skips.cycle_not_recovered++; continue; }

    const { count: paidAfter, error: ordErr } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("subscription_id", sub.id)
      .in("financial_status", ["PAID", "paid"])
      .gt("created_at", cycle.recovered_at as string);
    if (ordErr) throw new Error(`orders fetch for ${sub.id}: ${ordErr.message}`);
    if (!paidAfter || paidAfter === 0) { skips.no_paid_order_after++; continue; }

    toClear.push({ id: sub.id, recovered_at: cycle.recovered_at as string });
  }
  process.stdout.write("\n");

  console.log(`\nResolved:`);
  console.log(`  to clear (will set last_payment_status='succeeded'): ${toClear.length}`);
  console.log(`  skipped — no dunning cycle:                          ${skips.no_cycle}`);
  console.log(`  skipped — most-recent cycle not 'recovered':         ${skips.cycle_not_recovered}`);
  console.log(`  skipped — no paid order after recovered_at:          ${skips.no_paid_order_after}`);

  if (toClear.length === 0) {
    console.log("\nNothing to clear.");
    return;
  }

  // Sample
  console.log("\nSample (up to 5):");
  for (const r of toClear.slice(0, 5)) {
    console.log(`  ${r.id}  recovered_at=${r.recovered_at}`);
  }

  if (!APPLY) {
    console.log(`\nDry-run only. Re-run with --apply to clear ${toClear.length} rows.`);
    return;
  }

  // 3. Apply in batches.
  console.log(`\nClearing ${toClear.length} rows in batches of ${UPDATE_BATCH}...`);
  let updated = 0;
  for (let i = 0; i < toClear.length; i += UPDATE_BATCH) {
    const batchIds = toClear.slice(i, i + UPDATE_BATCH).map((r) => r.id);
    const { error, count } = await admin
      .from("subscriptions")
      .update({ last_payment_status: "succeeded", updated_at: new Date().toISOString() }, { count: "exact" })
      // Re-assert the filter — defence against any race where a row flipped state
      // between candidate-fetch and now. Only clear rows still in the broken state.
      .in("id", batchIds)
      .eq("is_internal", true)
      .eq("status", "active")
      .eq("last_payment_status", "failed");
    if (error) {
      console.log(`  ✗ batch ${i}: ${error.message}`);
    } else {
      updated += count || 0;
      process.stdout.write(`  updated ${updated}/${toClear.length}\r`);
    }
  }
  console.log(`\n  ✓ cleared ${updated} rows.`);
}

main().catch((e) => {
  console.error("ERR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
