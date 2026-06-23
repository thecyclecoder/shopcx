/**
 * Backfill orders.session_id (+ anonymous_id) from each order's order_placed event —
 * experiment-session-stamped-attribution Phase 2.
 *
 * Storefront orders created before this feature have no session_id. The canonical
 * order↔session link already existed indirectly: the server-emitted `order_placed`
 * storefront_event carries `meta.order_id` AND the converting `session_id` +
 * `anonymous_id`. This script materializes that link onto the order row so attribution
 * (orders.session_id → storefront_sessions.experiment_assignments) and the order-detail
 * Journey panel join it directly.
 *
 * Resolution = order_placed events → map order_id → { session_id, anonymous_id } → update
 * orders where session_id IS NULL. Set-when-null only; never overwrites a populated link.
 *
 * Two-phase + idempotent + resumable: dry-run by default (counts + samples); `--apply`
 * writes. Re-running skips already-linked rows (the IS NULL filter).
 *
 * Scope:
 *   default      — recent window only (order_placed created within RECENT_DAYS).
 *   --all-time   — the entire back catalogue (no date floor).
 *
 * Usage:
 *   npx tsx scripts/backfill-order-session-link.ts                  # recent, dry-run
 *   npx tsx scripts/backfill-order-session-link.ts --apply          # recent, write
 *   npx tsx scripts/backfill-order-session-link.ts --all-time --apply  # all-time, write
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const ALL_TIME = process.argv.includes("--all-time");
const RECENT_DAYS = 30;
const PAGE = 1000;

type Admin = ReturnType<typeof createAdminClient>;

async function fetchOrderPlacedLinks(
  admin: Admin,
  sinceIso: string | null,
): Promise<Map<string, { session_id: string; anonymous_id: string | null }>> {
  const byOrder = new Map<string, { session_id: string; anonymous_id: string | null }>();
  for (let page = 0; page < 200; page++) {
    let q = admin
      .from("storefront_events")
      .select("session_id, anonymous_id, meta, created_at, id")
      .eq("event_type", "order_placed")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (sinceIso) q = q.gte("created_at", sinceIso);
    const { data, error } = await q;
    if (error) throw error;
    const batch =
      (data as Array<{ session_id: string | null; anonymous_id: string | null; meta: Record<string, unknown> }>) || [];
    for (const row of batch) {
      const orderId = String(row.meta?.order_id ?? "");
      if (!orderId || !row.session_id) continue;
      // First (earliest) order_placed wins per order — stable, idempotent.
      if (!byOrder.has(orderId)) byOrder.set(orderId, { session_id: row.session_id, anonymous_id: row.anonymous_id });
    }
    if (batch.length < PAGE) break;
  }
  return byOrder;
}

async function main() {
  const admin = createAdminClient();
  const sinceIso = ALL_TIME ? null : new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  console.log(
    `Backfill orders.session_id — scope=${ALL_TIME ? "ALL-TIME" : `recent ${RECENT_DAYS}d (since ${sinceIso})`} · mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  const links = await fetchOrderPlacedLinks(admin, sinceIso);
  console.log(`Found ${links.size} order_placed events with a session link.`);

  let updated = 0;
  let missing = 0;
  const samples: string[] = [];
  for (const [orderId, link] of links) {
    // Only orders missing the link (set-when-null).
    const { data: order } = await admin
      .from("orders")
      .select("id, order_number, session_id")
      .eq("id", orderId)
      .maybeSingle();
    if (!order) {
      missing += 1;
      continue;
    }
    if (order.session_id) continue; // already linked
    if (samples.length < 10) samples.push(`${order.order_number} → session ${link.session_id}`);
    if (APPLY) {
      await admin
        .from("orders")
        .update({ session_id: link.session_id, anonymous_id: link.anonymous_id })
        .eq("id", orderId)
        .is("session_id", null);
    }
    updated += 1;
  }

  console.log(`\nOrders ${APPLY ? "updated" : "to update"}: ${updated}`);
  if (missing) console.log(`order_placed events whose order_id no longer exists: ${missing}`);
  if (samples.length) {
    console.log("Samples:");
    for (const s of samples) console.log(`  ${s}`);
  }
  if (!APPLY) console.log("\nDry-run only. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
