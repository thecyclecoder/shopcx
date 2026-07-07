/**
 * Backfill Phase 1 — populate public.order_refunds from historical
 * returns rows so the ledger is a complete audit record, not just a
 * mirror of refunds fired AFTER the base mirror shipped
 * (20260918120000_order_refunds_mirror.sql / PR #1265).
 *
 * See docs/brain/specs/backfill-order-refunds-ledger-from-history.md.
 *
 * Source: public.returns rows where `refunded_at IS NOT NULL` — the
 * structured, high-confidence path (Phase 2 will handle
 * customer_events best-effort). Each row carries the fields we need:
 *   - net_refund_cents  — the contract amount (see returns.md gotcha)
 *   - refund_id         — the vendor's refund identifier (or the
 *                         `direct_refund` sentinel when refundOrder
 *                         couldn't obtain one)
 *   - refunded_at       — when the refund landed
 *   - order_id          — the internal order UUID
 *
 * request_key policy — MUST match the live-fire path exactly so a
 * return refunded AFTER the mirror shipped (already in the ledger via
 * refundOrder) doesn't get duplicated by this backfill. The live path
 * (src/lib/inngest/returns.ts § returns-issue-refund) computes:
 *
 *   hashActionRefundKey("return", return_id, order_id, amountCents,
 *                       `Return ${order_number} delivered`)
 *
 * We use the same formula. If the same (order_id, request_key) pair
 * already exists, we skip — and the ON CONFLICT DO NOTHING against
 * the mirror's unique index (order_id, request_key) is the DB-level
 * backstop.
 *
 * vendor derivation — per the spec: `shopify_order_id` present ⇒
 * `shopify`, absent ⇒ `braintree` (the internal-order signal). We do
 * NOT try to reconstruct the Braintree-fallback-on-Shopify-order case
 * (that requires the historical Shopify transaction gateway probe,
 * which isn't retained). Vendor is what the order SHAPE says it is,
 * which is the exact rule the spec cites.
 *
 * status: 'settled' — historical refunds already landed; no Phase 3
 * reconcile pass needed for them.
 *
 * source: 'backfill' — the marker from the 20260922120000 migration
 * that this row didn't come from a live refundOrder() call.
 *
 * Dry-run by default. Pass --apply to write.
 *   npx tsx scripts/backfill-order-refunds-from-returns.ts            # dry-run
 *   npx tsx scripts/backfill-order-refunds-from-returns.ts --apply    # write
 */
import { pgClient } from "./_bootstrap";
import { hashActionRefundKey } from "../src/lib/refund";

const APPLY = process.argv.includes("--apply");
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const INSERT_BATCH = 500;

type Candidate = {
  return_id: string;
  workspace_id: string;
  order_id: string;
  order_number: string;
  net_refund_cents: number;
  refund_id: string | null;
  refunded_at: Date;
  shopify_order_id: string | null;
  request_key: string;
  vendor: "shopify" | "braintree";
};

async function main() {
  const c = pgClient();
  await c.connect();
  const t0 = Date.now();
  try {
    console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
    console.log(`Workspace: ${WS}\n`);

    // Phase-1 source of truth: returns joined to orders. `net_refund_cents > 0`
    // filters out the store-credit / zero-amount rows (returnsIssueRefund
    // never calls refundOrder for those, so there's nothing to mirror).
    // `order_id IS NOT NULL` skips a handful of orphan return rows that
    // predate the order-linking backfill — those can't key into
    // order_refunds (order_id is NOT NULL there).
    const { rows: raw } = await c.query<{
      return_id: string;
      workspace_id: string;
      order_id: string;
      order_number: string;
      net_refund_cents: number;
      refund_id: string | null;
      refunded_at: Date;
      shopify_order_id: string | null;
    }>(
      `SELECT
         r.id             AS return_id,
         r.workspace_id   AS workspace_id,
         r.order_id       AS order_id,
         r.order_number   AS order_number,
         r.net_refund_cents,
         r.refund_id,
         r.refunded_at,
         o.shopify_order_id
       FROM public.returns r
       JOIN public.orders  o ON o.id = r.order_id
       WHERE r.workspace_id = $1::uuid
         AND r.refunded_at IS NOT NULL
         AND r.order_id IS NOT NULL
         AND r.net_refund_cents > 0
       ORDER BY r.refunded_at ASC`,
      [WS],
    );

    console.log(`Candidate returns (refunded_at set, amount > 0, order linked): ${raw.length}`);

    const candidates: Candidate[] = raw.map((r) => {
      const reason = `Return ${r.order_number} delivered`;
      const request_key = hashActionRefundKey(
        "return",
        r.return_id,
        r.order_id,
        r.net_refund_cents,
        reason,
      );
      const vendor: "shopify" | "braintree" = r.shopify_order_id ? "shopify" : "braintree";
      return {
        return_id: r.return_id,
        workspace_id: r.workspace_id,
        order_id: r.order_id,
        order_number: r.order_number,
        net_refund_cents: r.net_refund_cents,
        refund_id: r.refund_id,
        refunded_at: r.refunded_at,
        shopify_order_id: r.shopify_order_id,
        request_key,
        vendor,
      };
    });

    // What already exists on those keys — the compose-with-live-mirror
    // check. The unique index (order_id, request_key) is workspace-agnostic,
    // so this pair is authoritative even in a single-tenant read.
    const keyPairs = candidates.map((c) => `${c.order_id}|${c.request_key}`);
    const { rows: existingRows } = await c.query<{ order_id: string; request_key: string; source: string }>(
      `SELECT order_id, request_key, source
         FROM public.order_refunds
        WHERE workspace_id = $1::uuid
          AND (order_id::text || '|' || request_key) = ANY($2::text[])`,
      [WS, keyPairs],
    );
    const existingSet = new Set(existingRows.map((r) => `${r.order_id}|${r.request_key}`));
    const bySource: Record<string, number> = {};
    for (const r of existingRows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;

    const toInsert = candidates.filter((c) => !existingSet.has(`${c.order_id}|${c.request_key}`));
    console.log(`Already in ledger: ${existingSet.size} (${JSON.stringify(bySource)})`);
    console.log(`To insert:         ${toInsert.length}`);

    const byVendor: Record<string, number> = {};
    for (const c of toInsert) byVendor[c.vendor] = (byVendor[c.vendor] ?? 0) + 1;
    console.log(`  by vendor: ${JSON.stringify(byVendor)}`);

    const withVendorId = toInsert.filter((c) => c.refund_id && c.refund_id !== "direct_refund").length;
    console.log(`  with real vendor_refund_id: ${withVendorId} / ${toInsert.length}`);

    if (toInsert.length > 0) {
      console.log(`\nFirst 5 to insert:`);
      for (const c of toInsert.slice(0, 5)) {
        console.log(
          `  return=${c.return_id.slice(0, 8)} order=${c.order_number} amt=$${(c.net_refund_cents / 100).toFixed(2)} ` +
            `vendor=${c.vendor} refund_id=${c.refund_id ?? "(null)"} refunded_at=${c.refunded_at.toISOString()}`,
        );
      }
    }

    if (!APPLY) {
      console.log(`\nDry-run only. Re-run with --apply to insert ${toInsert.length} rows.`);
      return;
    }

    if (toInsert.length === 0) {
      console.log(`\n✓ Nothing to insert — ledger already covers every historical return.`);
      return;
    }

    // Chunked bulk INSERT ... ON CONFLICT (order_id, request_key) DO NOTHING.
    // The ON CONFLICT is a belt-and-suspenders backstop — the in-Node
    // pre-check already dropped everything the mirror covers, but a
    // concurrent live refund (unlikely mid-backfill but not impossible)
    // could race and land the same key first, and the DB-level guard
    // is what makes that safe.
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
          c.refund_id, // vendor_refund_id — may be null or 'direct_refund'
          c.net_refund_cents,
          "settled",
          c.refunded_at,
          c.refunded_at,
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

    // Post-apply verification — every candidate return should now have
    // exactly one order_refunds row on its computed key.
    const { rows: verify } = await c.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM public.order_refunds
        WHERE workspace_id = $1::uuid
          AND (order_id::text || '|' || request_key) = ANY($2::text[])`,
      [WS, keyPairs],
    );
    console.log(`\nVerification: ${verify[0].n} / ${candidates.length} candidate returns present in order_refunds.`);
    if (verify[0].n !== candidates.length) {
      console.warn(`  ⚠ mismatch — expected ${candidates.length}, got ${verify[0].n}`);
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
