/**
 * Backfill Phase 2 of [[../docs/brain/specs/return-refund-includes-tax]].
 *
 * WHY. Phase 1 made `createFullReturn` ADD the tax allocated to the returned product to
 * `net_refund_cents` (founder rule 2026-11-19: "We don't withhold tax amounts from refunds. The
 * only thing we typically don't refund is shipping they paid or shipping protection."). But every
 * return CREATED BEFORE Phase 1 still carries a tax-less `net_refund_cents` (`order_subtotal −
 * refunds − label`), so when EasyPost delivers it the issue-refund pipeline will under-refund the
 * customer by exactly the product tax. This one-time, idempotent backfill raises those rows to the
 * Phase 1 formula using the SAME pure helpers + the order's LIVE refund ledger, so nobody is left
 * short and nobody is paid twice.
 *
 * WHAT. For every `public.returns` row whose `status NOT IN (refunded, cancelled, closed)` — i.e.
 * the refund has not yet fired, so the stored `net_refund_cents` is still a mutable promise:
 *   1. Resolve the order's product tax the way `createFullReturn` does — INTERNAL order
 *      (`shopify_order_id` null) → `orders.avalara_total_tax_cents`; Shopify order →
 *      `orders.payment_details.tax_cents`.
 *   2. `orderSubtotalCents = deriveOrderSubtotalCentsFromLines(line_items)` (strips Shipping
 *      Protection / paid shipping); `allocatedTaxCents = allocateReturnTaxCents(...)` — a stored
 *      return is a FULL return, so `returnedSubtotalCents === orderSubtotalCents` ⇒ the whole tax.
 *   3. `readReturnCreationRefundLedger(...)` — the LIVE refund ledger (the same reader
 *      `createFullReturn` uses). It wraps `getOrderRefundLedger` ([[../src/lib/refund-ledger]]) for
 *      Shopify orders (mirrored + out-of-band refunds) and derives a local ceiling for internal
 *      SHOPCX* orders, so this backfill NETS THE REFUND LEDGER exactly as creation does. A tax refund
 *      already issued out-of-band sits in `getOrderRefundLedger`'s `refundedCents` and NETS OUT.
 *   4. `newNet = clamp(computeReturnNetRefundCents({ subtotal, tax, label = the row's stored
 *      label_cost_cents, refundsSucceeded = ledger.refundedCents }), ledger.refundableCents)`.
 *   5. Write ONLY when `newNet > stored net_refund_cents` (never lower a committed promise). The
 *      write is a compare-and-set on `(id, workspace_id, status, net_refund_cents = old)` so a
 *      concurrent refund/cancel between read and write can't be clobbered.
 *
 * LEDGER NETTING IS THE SAFETY. Laurie Predmore's SHOPCX732 and SHOPCX712 returns already had their
 * tax refunded as a SEPARATE transaction on 2026-11-19 (the incident that spawned this spec). Their
 * tax now sits in the live ledger's `refundedCents`, so `subtotal + tax − refundedIncludingTax −
 * label == subtotal − label` = the value already stored ⇒ `newNet == oldNet` ⇒ the "raise only"
 * rule leaves them UNCHANGED and nobody is paid the tax twice. The dry-run asserts this explicitly
 * for both order numbers (a loud failure if either would be raised).
 *
 * TRACKED. Named `scripts/_backfill-*.ts` per the CLAUDE.md ship-time-backfill convention, so the
 * post-merge hook auto-ledgers it into [[../docs/brain/tables/data_op_runs]] and escalates the
 * pending row to the CEO inbox until it is drained on the box.
 *
 * IDEMPOTENT + RESUMABLE + CHUNKED. A second pass finds every row already tax-inclusive (newNet ==
 * oldNet) and writes nothing. Two-phase per the [[../.claude/skills/backfill]] convention: dry-run
 * by default (prints a per-row before/after + the Laurie assertion), `--apply` to write.
 *
 *   npx tsx scripts/_backfill-return-net-refund-tax.ts            # dry-run (default), all workspaces
 *   npx tsx scripts/_backfill-return-net-refund-tax.ts --apply    # write
 *
 * See [[../docs/brain/specs/return-refund-includes-tax]] Phase 2 and [[../docs/brain/tables/returns]].
 */
import { createAdminClient } from "./_bootstrap";
import {
  allocateReturnTaxCents,
  clampNetRefundToLiveCeiling,
  computeReturnNetRefundCents,
  deriveOrderSubtotalCentsFromLines,
  readReturnCreationRefundLedger,
  type OrderLineItemLite,
} from "../src/lib/shopify-returns";

const APPLY = process.argv.includes("--apply");
const CHUNK = 200;

// Terminal states where `net_refund_cents` is no longer a mutable promise — the refund already
// fired (refunded), the return was voided (cancelled), or it was administratively closed.
const SKIP_STATUSES = ["refunded", "cancelled", "closed"] as const;

// Laurie Predmore's two returns whose tax was refunded out-of-band on 2026-11-19 — the ledger
// netting MUST leave them unchanged. Asserted in the dry-run output.
const LEDGER_NETTED_UNCHANGED = new Set(["SHOPCX732", "SHOPCX712"]);

interface ReturnRow {
  id: string;
  workspace_id: string;
  order_id: string | null;
  order_number: string | null;
  status: string;
  net_refund_cents: number | null;
  label_cost_cents: number | null;
  created_at: string;
}

interface OrderRow {
  line_items: OrderLineItemLite[] | null;
  shopify_order_id: string | null;
  avalara_total_tax_cents: number | null;
  payment_details: { tax_cents?: number | null } | null;
}

/** Resolve the order's product tax exactly as `createFullReturn` does (origin-split). */
function resolveOrderTaxCents(order: OrderRow): number {
  if (!order.shopify_order_id) {
    return Math.max(0, Math.round(order.avalara_total_tax_cents ?? 0));
  }
  return Math.max(0, Math.round(order.payment_details?.tax_cents ?? 0));
}

async function recomputeNet(
  admin: ReturnType<typeof createAdminClient>,
  row: ReturnRow,
): Promise<{ newNet: number; orderMissing: boolean }> {
  if (!row.order_id) return { newNet: row.net_refund_cents ?? 0, orderMissing: true };

  const { data: order } = await admin
    .from("orders")
    .select("line_items, shopify_order_id, avalara_total_tax_cents, payment_details")
    .eq("id", row.order_id)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();
  if (!order) return { newNet: row.net_refund_cents ?? 0, orderMissing: true };

  const typed = order as unknown as OrderRow;
  const orderSubtotalCents = deriveOrderSubtotalCentsFromLines(typed.line_items);
  const orderTaxCents = resolveOrderTaxCents(typed);
  const allocatedTaxCents = allocateReturnTaxCents({
    orderTaxCents,
    orderSubtotalCents,
    returnedSubtotalCents: orderSubtotalCents, // a stored return is a FULL return
  });
  const ledger = await readReturnCreationRefundLedger(admin, row.workspace_id, row.order_id);
  const rawNet = computeReturnNetRefundCents({
    orderSubtotalCents,
    taxCents: allocatedTaxCents,
    labelCostCents: Math.max(0, Math.round(row.label_cost_cents ?? 0)),
    refundsSucceededCents: ledger.refundedCents,
  });
  const clamped = clampNetRefundToLiveCeiling({
    netRefundCents: rawNet,
    refundableCents: ledger.refundableCents,
  });
  return { newNet: clamped.netRefundCents, orderMissing: false };
}

async function main() {
  const admin = createAdminClient();

  const totals = {
    scanned: 0,
    raised: 0,
    unchanged: 0,
    orderMissing: 0,
    written: 0,
    laurieAsserted: 0,
    laurieViolations: 0,
  };

  // Resumable cursor over (created_at, id) — pagination without OFFSET.
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = admin
      .from("returns")
      .select("id, workspace_id, order_id, order_number, status, net_refund_cents, label_cost_cents, created_at")
      .not("status", "in", `(${SKIP_STATUSES.join(",")})`)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursorCreatedAt && cursorId) {
      q = q.or(`created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(`returns read failed: ${error.message}`);
    const page = (rows ?? []) as ReturnRow[];
    if (page.length === 0) break;

    for (const row of page) {
      totals.scanned += 1;
      const oldNet = Math.max(0, Math.round(row.net_refund_cents ?? 0));
      const { newNet, orderMissing } = await recomputeNet(admin, row);

      if (orderMissing) {
        totals.orderMissing += 1;
        console.log(`  · ${row.order_number ?? row.id} [${row.status}] order missing — skipped (net unchanged $${(oldNet / 100).toFixed(2)})`);
        continue;
      }

      const raise = newNet - oldNet;
      const isLaurie = LEDGER_NETTED_UNCHANGED.has(String(row.order_number));

      if (isLaurie) {
        totals.laurieAsserted += 1;
        if (newNet > oldNet) {
          totals.laurieViolations += 1;
          console.log(`  ✗ LEDGER-NETTING ASSERTION FAILED — ${row.order_number} would be RAISED $${(oldNet / 100).toFixed(2)} → $${(newNet / 100).toFixed(2)}; its tax was already refunded out-of-band and must net to ZERO raise. NOT writing.`);
          continue; // never raise a ledger-netted row even under --apply
        }
        console.log(`  ✓ ledger-netting assertion OK — ${row.order_number} unchanged at $${(oldNet / 100).toFixed(2)} (tax already refunded out-of-band nets out)`);
      }

      if (raise <= 0) {
        totals.unchanged += 1;
        continue;
      }

      totals.raised += 1;
      console.log(`  ${APPLY ? "→" : "·"} ${row.order_number ?? row.id} [${row.status}] net_refund $${(oldNet / 100).toFixed(2)} → $${(newNet / 100).toFixed(2)} (+$${(raise / 100).toFixed(2)} tax)`);

      if (APPLY) {
        // Compare-and-set: only rewrite the row still carrying the value + status we read, in its
        // workspace, so a concurrent refund/cancel between read and write is never clobbered. The
        // .select("id") asserts exactly one row transitioned (or none — a raced row is skipped).
        const { data: updated, error: updErr } = await admin
          .from("returns")
          .update({ net_refund_cents: newNet, updated_at: new Date().toISOString() })
          .eq("id", row.id)
          .eq("workspace_id", row.workspace_id)
          .eq("status", row.status)
          .eq("net_refund_cents", oldNet)
          .select("id");
        if (updErr) {
          console.error(`  ! update failed for ${row.order_number ?? row.id}: ${updErr.message}`);
        } else if ((updated ?? []).length === 1) {
          totals.written += 1;
        } else {
          console.log(`  (skipped ${row.order_number ?? row.id} — row changed since read, compare-and-set matched 0 rows)`);
        }
      }
    }

    cursorCreatedAt = page[page.length - 1].created_at;
    cursorId = page[page.length - 1].id;
    if (page.length < CHUNK) break;
  }

  console.log("\n── summary ──");
  console.log(`  scanned (non-terminal returns): ${totals.scanned}`);
  console.log(`  would-raise (tax added):        ${totals.raised}`);
  console.log(`  unchanged (already tax-inclusive or lower): ${totals.unchanged}`);
  console.log(`  order missing (skipped):        ${totals.orderMissing}`);
  console.log(`  ledger-netted rows asserted:    ${totals.laurieAsserted} (violations: ${totals.laurieViolations})`);
  if (APPLY) console.log(`  rows written:                   ${totals.written}`);
  console.log(`\nDone${APPLY ? " (applied)" : " (dry-run — pass --apply to write)"}.`);

  if (totals.laurieViolations > 0) {
    console.error("\n❌ A ledger-netted return (Laurie SHOPCX732/SHOPCX712) would have been raised — the live ledger did not net the out-of-band tax refund. Investigate before applying.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
