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
import { createAdminClient, pgClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const ALL_TIME = process.argv.includes("--all-time");
const RECENT_DAYS = 30;
const PAGE = 1000;
// Order rows written per set-based UPDATE ... FROM (VALUES ...) statement.
const WRITE_BATCH = 1000;

type Admin = ReturnType<typeof createAdminClient>;

async function fetchOrderPlacedLinks(
  admin: Admin,
  sinceIso: string | null,
): Promise<Map<string, { session_id: string; anonymous_id: string | null }>> {
  const byOrder = new Map<string, { session_id: string; anonymous_id: string | null }>();
  // No hard page cap — the short-page break terminates naturally, and a giant
  // catalogue (--all-time) must not be silently truncated at 200K events.
  for (let page = 0; ; page++) {
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

  const orderIds = [...links.keys()];
  const pg = pgClient();
  await pg.connect();
  let updated = 0;
  try {
    // How many of those order_ids still exist (missing = links − existing).
    const { rows: existRows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE id = ANY($1::uuid[])`,
      [orderIds],
    );
    const existing = Number(existRows[0]?.n ?? 0);
    const missing = links.size - existing;

    // How many still need the link (set-when-null) — the true to-update count,
    // computed set-based instead of a per-order existence SELECT.
    const { rows: pendRows } = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM orders WHERE id = ANY($1::uuid[]) AND session_id IS NULL`,
      [orderIds],
    );
    const toUpdate = Number(pendRows[0]?.n ?? 0);

    // Samples (order_number → session), no per-row existence probe.
    const { rows: sampleRows } = await pg.query<{ id: string; order_number: string | null }>(
      `SELECT id, order_number FROM orders WHERE id = ANY($1::uuid[]) AND session_id IS NULL LIMIT 10`,
      [orderIds],
    );
    const samples = sampleRows.map((r) => `${r.order_number} → session ${links.get(r.id)?.session_id}`);

    if (APPLY) {
      // Collapse writes to one UPDATE ... FROM (VALUES ...) per batch. The
      // `session_id IS NULL` guard makes it a no-op on already-linked rows
      // (idempotent) — no need for the old existence SELECT.
      for (let i = 0; i < orderIds.length; i += WRITE_BATCH) {
        const chunk = orderIds.slice(i, i + WRITE_BATCH);
        const params: unknown[] = [];
        const tuples: string[] = [];
        let p = 1;
        for (const oid of chunk) {
          const link = links.get(oid)!;
          tuples.push(`($${p++}::uuid, $${p++}::uuid, $${p++}::text)`);
          params.push(oid, link.session_id, link.anonymous_id);
        }
        const res = await pg.query(
          `UPDATE orders AS o
              SET session_id = v.sid, anonymous_id = v.aid
             FROM (VALUES ${tuples.join(", ")}) AS v(oid, sid, aid)
            WHERE o.id = v.oid AND o.session_id IS NULL`,
          params,
        );
        updated += res.rowCount ?? 0;
      }
    } else {
      updated = toUpdate;
    }

    console.log(`\nOrders ${APPLY ? "updated" : "to update"}: ${updated}`);
    if (missing) console.log(`order_placed events whose order_id no longer exists: ${missing}`);
    if (samples.length) {
      console.log("Samples:");
      for (const s of samples) console.log(`  ${s}`);
    }
    if (!APPLY) console.log("\nDry-run only. Re-run with --apply to write.");
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
