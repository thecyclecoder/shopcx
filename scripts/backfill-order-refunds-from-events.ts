/**
 * Backfill Phase 2 — best-effort populate public.order_refunds from
 * historical customer_events order.refunded rows and REPORT the gap.
 *
 * See docs/brain/specs/backfill-order-refunds-ledger-from-history.md.
 *
 * Source: public.customer_events rows where `event_type = 'order.refunded'`.
 * Three writers produce this shape (git-grep confirmed):
 *   - src/lib/refund.ts               — the modern authoritative writer.
 *                                       properties = { order_id (uuid),
 *                                       order_number, amount_cents, method,
 *                                       refund_id, reason, ... }
 *   - src/lib/shopify-webhooks.ts     — the Shopify order.updated webhook
 *                                       flip to refunded/partially_refunded.
 *                                       properties = { shopify_order_id,
 *                                       order_number, total_price (string $),
 *                                       financial_status } — no amount_cents,
 *                                       no refund_id, no method.
 *   - fraud-cases confirm-fraud route — inherits refund.ts's shape via
 *                                       refundOrder().
 *
 * The 2026-07-07 scan the spec cites: 249 order.refunded rows, 242 with
 * method='?'/no amount, ~1 attributable to an internal (Braintree) order.
 * That means the RECOVERABLE set is single-digit — most events are lossy.
 * We DO NOT fabricate an amount or a vendor refund id for the lossy
 * ones — we count them, log the breakdown, and expose the gap
 * explicitly (the spec: "no silent truncation").
 *
 * Recoverable predicate: BOTH `properties.amount_cents` is a positive
 * integer AND `properties.refund_id` is a non-empty string. Anything
 * else is unrecoverable-from-events.
 *
 * Order resolution — per the spec ("properties.order_id or order_number"):
 *   (1) properties.order_id (an internal orders.id UUID) — the modern
 *       refund.ts path. Preferred when present.
 *   (2) properties.order_number → orders lookup by workspace_id + order_number.
 * Cross-check: the resolved order's workspace_id must match the event's
 * workspace_id (single-tenant today but the check is cheap and defensive).
 *
 * Dedup — the spec's two constraints:
 *   (a) "multiple event-logs of the SAME refund_id collapse to one row"
 *       — our request_key is
 *         hashActionRefundKey("event", refund_id, order_id, amount_cents, "")
 *       so N event rows carrying the same refund_id ALL derive the same
 *       key and collide on the (order_id, request_key) unique index.
 *   (b) "anything already in the ledger (returns backfill or live mirror)
 *       is skipped" — Phase 1 rows and live-fire mirror rows carry the
 *       actual vendor refund_id in `vendor_refund_id`. Before inserting
 *       we look up `order_refunds` by (workspace_id, order_id,
 *       vendor_refund_id) and skip when the same refund already exists
 *       under ANY key. This is the semantic guard the coaching pins: we
 *       check the ACTUAL condition (same refund identity landed in the
 *       ledger), not a coarse (order_id, request_key)-only proxy. The
 *       (order_id, request_key) unique index is the second-layer
 *       backstop against races via ON CONFLICT DO NOTHING.
 *
 * vendor derivation: per Phase 1's rule — order.shopify_order_id present
 * ⇒ 'shopify', absent ⇒ 'braintree' (the internal-order signal). We
 * ignore properties.method because it's populated only on the modern
 * writer path (the exact rows already covered by the live mirror) and
 * missing on the Shopify-webhook path; the order-shape rule is uniform
 * across both.
 *
 * status: 'settled' — historical refund; already landed. No Phase 3
 * T+3d reconcile pass needed.
 *
 * source: 'backfill' — the marker from the 20260922120000 migration
 * that this row didn't come from a live refundOrder() call.
 *
 * Dry-run by default. Pass --apply to write.
 *   npx tsx scripts/backfill-order-refunds-from-events.ts            # dry-run
 *   npx tsx scripts/backfill-order-refunds-from-events.ts --apply    # write
 */
import { pgClient } from "./_bootstrap";
import { hashActionRefundKey } from "../src/lib/refund";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const INSERT_BATCH = 500;

type EventRow = {
  event_id: string;
  workspace_id: string;
  created_at: Date;
  properties: {
    order_id?: string | null;
    order_number?: string | number | null;
    amount_cents?: number | null;
    refund_id?: string | null;
    method?: string | null;
    total_price?: string | null;
    financial_status?: string | null;
    shopify_order_id?: string | null;
  };
};

type Candidate = {
  event_id: string;
  workspace_id: string;
  order_id: string;
  order_number: string;
  amount_cents: number;
  refund_id: string;
  event_created_at: Date;
  shopify_order_id: string | null;
  request_key: string;
  vendor: "shopify" | "braintree";
};

type UnrecoverableReason =
  | "no_amount_and_no_refund_id"
  | "no_amount"
  | "no_refund_id"
  | "unresolved_order";

async function main() {
  const c = pgClient();
  await c.connect();
  const t0 = Date.now();
  try {
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`Workspace: ${WS}\n`);

    // Every historical order.refunded event for this workspace.
    const { rows: events } = await c.query<EventRow>(
      `SELECT
         id           AS event_id,
         workspace_id,
         created_at,
         COALESCE(properties, '{}'::jsonb) AS properties
       FROM public.customer_events
       WHERE workspace_id = $1::uuid
         AND event_type   = 'order.refunded'
       ORDER BY created_at ASC`,
      [WS],
    );
    console.log(`order.refunded events found: ${events.length}`);

    // Preload the order lookup — one round trip for every order_number
    // + order_id referenced by any event. Cheap for a ≤300-row event set.
    const orderIds = new Set<string>();
    const orderNumbers = new Set<string>();
    for (const e of events) {
      const p = e.properties || {};
      if (typeof p.order_id === "string" && p.order_id) orderIds.add(p.order_id);
      if (p.order_number != null) orderNumbers.add(String(p.order_number));
    }
    const { rows: ordersById } = orderIds.size
      ? await c.query<{ id: string; shopify_order_id: string | null; order_number: string | null }>(
          `SELECT id, shopify_order_id, order_number
             FROM public.orders
            WHERE workspace_id = $1::uuid
              AND id = ANY($2::uuid[])`,
          [WS, [...orderIds]],
        )
      : { rows: [] };
    const { rows: ordersByNumber } = orderNumbers.size
      ? await c.query<{ id: string; shopify_order_id: string | null; order_number: string | null }>(
          `SELECT id, shopify_order_id, order_number
             FROM public.orders
            WHERE workspace_id = $1::uuid
              AND order_number = ANY($2::text[])`,
          [WS, [...orderNumbers]],
        )
      : { rows: [] };
    const byId = new Map(ordersById.map((o) => [o.id, o]));
    const byNumber = new Map(ordersByNumber.map((o) => [o.order_number ?? "", o]));

    const candidates: Candidate[] = [];
    const unrecoverable: Record<UnrecoverableReason, number> = {
      no_amount_and_no_refund_id: 0,
      no_amount: 0,
      no_refund_id: 0,
      unresolved_order: 0,
    };
    const unrecoverableSamples: { event_id: string; reason: UnrecoverableReason; keys: string[] }[] = [];

    for (const e of events) {
      const p = e.properties || {};
      const amountRaw = p.amount_cents;
      const refundIdRaw = p.refund_id;
      const amount = typeof amountRaw === "number" && Number.isFinite(amountRaw) ? amountRaw : null;
      const refundId = typeof refundIdRaw === "string" && refundIdRaw.length > 0 ? refundIdRaw : null;
      const noAmount = amount === null || amount <= 0;
      const noRefundId = refundId === null;

      if (noAmount && noRefundId) {
        unrecoverable.no_amount_and_no_refund_id++;
        if (unrecoverableSamples.length < 8) {
          unrecoverableSamples.push({
            event_id: e.event_id,
            reason: "no_amount_and_no_refund_id",
            keys: Object.keys(p),
          });
        }
        continue;
      }
      if (noAmount) {
        unrecoverable.no_amount++;
        if (unrecoverableSamples.length < 8) {
          unrecoverableSamples.push({ event_id: e.event_id, reason: "no_amount", keys: Object.keys(p) });
        }
        continue;
      }
      if (noRefundId) {
        unrecoverable.no_refund_id++;
        if (unrecoverableSamples.length < 8) {
          unrecoverableSamples.push({ event_id: e.event_id, reason: "no_refund_id", keys: Object.keys(p) });
        }
        continue;
      }

      // Resolve the order — properties.order_id first, then order_number.
      let order: { id: string; shopify_order_id: string | null; order_number: string | null } | null = null;
      if (typeof p.order_id === "string" && p.order_id) order = byId.get(p.order_id) ?? null;
      if (!order && p.order_number != null) order = byNumber.get(String(p.order_number)) ?? null;
      if (!order) {
        unrecoverable.unresolved_order++;
        if (unrecoverableSamples.length < 8) {
          unrecoverableSamples.push({
            event_id: e.event_id,
            reason: "unresolved_order",
            keys: Object.keys(p),
          });
        }
        continue;
      }

      const vendor: "shopify" | "braintree" = order.shopify_order_id ? "shopify" : "braintree";
      // Same-refund events collapse: refund_id in the actor slot means
      // N events for the SAME refund_id all derive the SAME key. The
      // (order_id, request_key) unique index folds them at the DB layer.
      const request_key = hashActionRefundKey("event", refundId, order.id, amount, "");
      candidates.push({
        event_id: e.event_id,
        workspace_id: e.workspace_id,
        order_id: order.id,
        order_number: order.order_number ?? String(p.order_number ?? ""),
        amount_cents: amount,
        refund_id: refundId,
        event_created_at: e.created_at,
        shopify_order_id: order.shopify_order_id,
        request_key,
        vendor,
      });
    }

    // Fold same-refund_id events into one candidate per (order_id, request_key).
    // Multiple events with the same refund_id → same key → we only want ONE
    // insert row. Keep the earliest event (stable, and typically the primary
    // fire; subsequent duplicates are re-logs).
    const byKey = new Map<string, Candidate>();
    for (const c of candidates) {
      const k = `${c.order_id}|${c.request_key}`;
      const prev = byKey.get(k);
      if (!prev || c.event_created_at < prev.event_created_at) byKey.set(k, c);
    }
    const collapsed = [...byKey.values()];
    const collapsedFrom = candidates.length - collapsed.length;
    console.log(
      `Recoverable events:      ${candidates.length} → ${collapsed.length} unique refunds ` +
        `(${collapsedFrom} same-refund duplicates collapsed)`,
    );

    // Skip anything the ledger already covers. Two-pronged: (1) matching
    // vendor_refund_id catches Phase 1 (returns) rows + live-mirror rows
    // that fired with the same vendor id; (2) our request_key catches
    // prior Phase 2 rows and same-batch collapse we've already handled
    // above but we still check as a belt-and-suspenders.
    const refundIds = [...new Set(collapsed.map((c) => c.refund_id))];
    const keyPairs = collapsed.map((c) => `${c.order_id}|${c.request_key}`);
    const orderIdList = [...new Set(collapsed.map((c) => c.order_id))];
    const { rows: alreadyByVendorId } = refundIds.length
      ? await c.query<{ order_id: string; vendor_refund_id: string; source: string }>(
          `SELECT order_id, vendor_refund_id, source
             FROM public.order_refunds
            WHERE workspace_id = $1::uuid
              AND order_id = ANY($2::uuid[])
              AND vendor_refund_id = ANY($3::text[])`,
          [WS, orderIdList, refundIds],
        )
      : { rows: [] };
    const alreadyByVendor = new Set(alreadyByVendorId.map((r) => `${r.order_id}|${r.vendor_refund_id}`));
    const { rows: alreadyByKey } = keyPairs.length
      ? await c.query<{ order_id: string; request_key: string; source: string }>(
          `SELECT order_id, request_key, source
             FROM public.order_refunds
            WHERE workspace_id = $1::uuid
              AND (order_id::text || '|' || request_key) = ANY($2::text[])`,
          [WS, keyPairs],
        )
      : { rows: [] };
    const alreadyByKeySet = new Set(alreadyByKey.map((r) => `${r.order_id}|${r.request_key}`));

    const toInsert = collapsed.filter(
      (c) =>
        !alreadyByVendor.has(`${c.order_id}|${c.refund_id}`) &&
        !alreadyByKeySet.has(`${c.order_id}|${c.request_key}`),
    );
    const alreadyLedgered = collapsed.length - toInsert.length;

    console.log(`Already in ledger:       ${alreadyLedgered}`);
    console.log(`  · by vendor_refund_id: ${alreadyByVendor.size}`);
    console.log(`  · by request_key:      ${alreadyByKeySet.size}`);
    console.log(`To insert:               ${toInsert.length}`);
    const byVendorCount: Record<string, number> = {};
    for (const c of toInsert) byVendorCount[c.vendor] = (byVendorCount[c.vendor] ?? 0) + 1;
    console.log(`  · by vendor:           ${JSON.stringify(byVendorCount)}`);

    console.log(
      `\nUnrecoverable-from-events (NOT fabricated, tracked as coverage gap): ${
        unrecoverable.no_amount + unrecoverable.no_refund_id + unrecoverable.no_amount_and_no_refund_id +
        unrecoverable.unresolved_order
      }`,
    );
    console.log(`  · no amount AND no refund_id: ${unrecoverable.no_amount_and_no_refund_id}`);
    console.log(`  · no amount:                  ${unrecoverable.no_amount}`);
    console.log(`  · no refund_id:               ${unrecoverable.no_refund_id}`);
    console.log(`  · unresolved order:           ${unrecoverable.unresolved_order}`);
    if (unrecoverableSamples.length > 0) {
      console.log(`\n  Sample unrecoverable events:`);
      for (const s of unrecoverableSamples.slice(0, 6)) {
        console.log(`    event=${s.event_id.slice(0, 8)} reason=${s.reason} property_keys=[${s.keys.join(", ")}]`);
      }
    }

    if (toInsert.length > 0) {
      console.log(`\nFirst 5 to insert:`);
      for (const c of toInsert.slice(0, 5)) {
        console.log(
          `  event=${c.event_id.slice(0, 8)} order=${c.order_number} amt=$${(c.amount_cents / 100).toFixed(2)} ` +
            `vendor=${c.vendor} refund_id=${c.refund_id} at=${c.event_created_at.toISOString()}`,
        );
      }
    }

    if (!APPLY) {
      console.log(`\nDry-run only. Re-run with --apply to insert ${toInsert.length} rows.`);
      return;
    }

    if (toInsert.length === 0) {
      console.log(`\n✓ Nothing to insert — every recoverable event is already covered by the ledger.`);
      return;
    }

    // Chunked bulk INSERT with the DB-level double-refund guard.
    // ON CONFLICT (order_id, request_key) DO NOTHING is the belt-and-
    // suspenders backstop for a concurrent live refund that lands between
    // our pre-check and our insert.
    let inserted = 0;
    let conflicted = 0;
    for (let i = 0; i < toInsert.length; i += INSERT_BATCH) {
      const chunk = toInsert.slice(i, i + INSERT_BATCH);
      const params: unknown[] = [];
      const rowsSql: string[] = [];
      for (const c of chunk) {
        const base = params.length;
        params.push(
          c.workspace_id,
          c.order_id,
          c.request_key,
          c.vendor,
          c.refund_id,
          c.amount_cents,
          "settled",
          c.event_created_at,
          c.event_created_at,
          "backfill",
        );
        rowsSql.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::text, ` +
            `$${base + 4}::text, $${base + 5}::text, $${base + 6}::int, ` +
            `$${base + 7}::text, $${base + 8}::timestamptz, $${base + 9}::timestamptz, ` +
            `$${base + 10}::text)`,
        );
      }
      const res = await c.query(
        `INSERT INTO public.order_refunds
           (workspace_id, order_id, request_key, vendor, vendor_refund_id,
            amount_cents, status, requested_at, settled_at, source)
         VALUES ${rowsSql.join(", ")}
         ON CONFLICT (order_id, request_key) DO NOTHING`,
        params,
      );
      const rowCount = res.rowCount ?? 0;
      inserted += rowCount;
      conflicted += chunk.length - rowCount;
      process.stdout.write(`  inserted ${inserted}/${toInsert.length} (raced/conflicted: ${conflicted})\r`);
    }
    console.log(`\n✓ inserted ${inserted} rows (${conflicted} skipped by unique-index guard).`);

    // Post-apply verification — every candidate is either now in the
    // ledger under our key OR was already covered by vendor_refund_id.
    const { rows: verifyByKey } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM public.order_refunds
        WHERE workspace_id = $1::uuid
          AND (order_id::text || '|' || request_key) = ANY($2::text[])`,
      [WS, keyPairs],
    );
    console.log(
      `\nVerification: ${verifyByKey[0].n} / ${collapsed.length} recoverable refunds present on our request_key ` +
        `(remainder already covered by vendor_refund_id match).`,
    );

    // "A post-backfill query can total historical refunds and internal-
    // order refunds from order_refunds alone." Report the totals so the
    // gap is visible without a follow-up query.
    const { rows: totals } = await c.query<{ n: number; cents: string; vendor: string; source: string }>(
      `SELECT vendor, source, COUNT(*)::int AS n, SUM(amount_cents)::text AS cents
         FROM public.order_refunds
        WHERE workspace_id = $1::uuid
     GROUP BY vendor, source
     ORDER BY vendor, source`,
      [WS],
    );
    console.log(`\nOrder_refunds totals (post-apply):`);
    for (const t of totals) {
      const dollars = (Number(t.cents ?? 0) / 100).toFixed(2);
      console.log(`  vendor=${t.vendor} source=${t.source}  n=${t.n}  total=$${dollars}`);
    }

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✓ DONE in ${elapsedSec}s.`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
