/**
 * Backfill daily_amazon_product_snapshots over a historical range (Phase 3 of
 * amazon-per-product-sales-attribution). Re-requests GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL
 * in chunks and runs processOrderReport per chunk — which writes BOTH the aggregate
 * (daily_amazon_order_snapshots, idempotent re-assert) AND the new per-product table.
 *
 * Idempotent + resumable: every write is an upsert keyed by (connection, date[, asin], bucket), so a
 * re-run over the same window re-asserts the same numbers. After each chunk it reconciles the
 * per-product sum against the aggregate per (date, bucket) and logs any drift — never silently truncates.
 *
 * Two-phase: dry-run by default (lists the chunks it WOULD pull). Pass --apply to actually pull + write.
 *   npx tsx scripts/backfill-amazon-product-snapshots.ts --start 2026-05-01 --end 2026-06-21 --apply
 *   npx tsx scripts/backfill-amazon-product-snapshots.ts --apply        # defaults: last 90d → today
 */
import { createAdminClient } from "./_bootstrap";

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const argOf = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const today = new Date().toISOString().slice(0, 10);
  const start = argOf("--start") || addDays(today, -90);
  const end = argOf("--end") || today;
  const chunkDays = parseInt(argOf("--chunk") || "7", 10);

  const admin = createAdminClient();

  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, workspace_id, marketplace_id, is_active")
    .eq("is_active", true)
    .maybeSingle();
  if (!conn) {
    console.log("No active amazon_connection — nothing to backfill.");
    return;
  }
  console.log(`Connection ${conn.id} · range ${start} → ${end} · ${chunkDays}d chunks · ${apply ? "APPLY" : "DRY-RUN"}\n`);

  // Import the live SP-API helpers lazily (they need the same env the bootstrap loaded).
  const { requestReport, pollReportStatus, downloadReport, processOrderReport } = await import(
    "../src/lib/amazon/sync-orders"
  );

  for (let cursor = start; cursor < end; cursor = addDays(cursor, chunkDays)) {
    const chunkEnd = addDays(cursor, chunkDays) > end ? end : addDays(cursor, chunkDays);
    console.log(`── chunk ${cursor} → ${chunkEnd} ──`);
    if (!apply) {
      console.log("  (dry-run, no pull)");
      continue;
    }

    try {
      const reportId = await requestReport(conn.id, conn.marketplace_id, cursor + "T00:00:00Z", chunkEnd + "T00:00:00Z");
      let documentId: string | null = null;
      for (let i = 0; i < 60; i++) {
        const s = await pollReportStatus(conn.id, conn.marketplace_id, reportId);
        if (s.status === "DONE") { documentId = s.documentId; break; }
        if (s.status === "CANCELLED" || s.status === "FATAL") { console.log(`  report ${s.status}, skip`); break; }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!documentId) { console.log("  report timed out, skip"); continue; }

      const tsv = await downloadReport(conn.id, conn.marketplace_id, documentId);
      const res = await processOrderReport({ workspaceId: conn.workspace_id, connectionId: conn.id, reportTsv: tsv });
      console.log(`  processed: ${res.orderCount} orders · ${res.snapshotCount} agg snapshots · ${res.productSnapshotCount} product snapshots`);

      // Reconcile per-product sum vs aggregate for each (date, bucket) in this window.
      const { data: agg } = await admin
        .from("daily_amazon_order_snapshots")
        .select("snapshot_date, order_bucket, gross_revenue_cents")
        .eq("amazon_connection_id", conn.id)
        .gte("snapshot_date", cursor)
        .lt("snapshot_date", chunkEnd);
      const { data: prod } = await admin
        .from("daily_amazon_product_snapshots")
        .select("snapshot_date, order_bucket, gross_revenue_cents")
        .eq("amazon_connection_id", conn.id)
        .gte("snapshot_date", cursor)
        .lt("snapshot_date", chunkEnd);

      const prodSum = new Map<string, number>();
      for (const r of prod || []) {
        const k = `${r.snapshot_date}|${r.order_bucket}`;
        prodSum.set(k, (prodSum.get(k) || 0) + (r.gross_revenue_cents || 0));
      }
      for (const a of agg || []) {
        const k = `${a.snapshot_date}|${a.order_bucket}`;
        const ps = prodSum.get(k) || 0;
        const drift = ps - (a.gross_revenue_cents || 0);
        if (drift !== 0) console.log(`  ⚠ drift ${k}: per-product ${ps} vs aggregate ${a.gross_revenue_cents} (Δ${drift})`);
      }
    } catch (err) {
      console.error(`  chunk error:`, err instanceof Error ? err.message : err);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
