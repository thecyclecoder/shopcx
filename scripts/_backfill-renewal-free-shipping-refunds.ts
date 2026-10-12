/**
 * Ship-time backfill: refund wrongly-charged subscription-renewal shipping (and ONLY the
 * tax attributable to that shipping) on every `internal_subscription_renewal` order in a
 * workspace whose free-shipping guarantee (`workspaces.subscription_free_shipping`) should
 * have made the renewal ship free.
 *
 * Phase 1 of `subscription-renewals-must-honor-free-shipping-guarantee` fixed the WRITER:
 * [[../src/lib/pricing]] `resolveSubscriptionPricing` now zeroes `shipping_cents` when the
 * workspace guarantee applies, so every FUTURE renewal ships free. This script is the
 * matching fleet-wide remediation for the renewals ALREADY charged the flat
 * `delivery_price_cents` ($4.95) before the writer fix — the recurring overcharge in ticket
 * `00618fac` (CS Director June refunded it three consecutive cycles as one-off partial
 * refunds and it recurred on the fourth).
 *
 * ⭐ Refunds SHIPPING + TAX-ON-SHIPPING ONLY — never product sales tax. The prior ad-hoc
 * refunds mistakenly also refunded legitimate product tax (June refunded ~$10.17 on an order
 * whose true defect was ~$5.42 = $4.95 shipping + ~$0.47 proportional tax). The per-order
 * defect here is `shipping_cents + round(tax_cents × shipping_cents / taxable_base)`, where
 * `taxable_base = max(0, subtotal − discount) + shipping + protection`.
 *
 * Guards (coaching #11/#12 — gate the mutation on a confirming predicate, never a bare match):
 *   - Workspace guarantee must currently be ON, and the order's net product subtotal must
 *     clear `subscription_free_shipping_threshold_cents` when a threshold is set (a null/0
 *     threshold is the no-minimum guarantee). An order that was legitimately charged shipping
 *     is never touched.
 *   - An order that ALREADY carries a succeeded/settled `order_refunds` row is NOT re-refunded
 *     — it is reported as `already_refunded` for human reconciliation (the Jul/Aug/Sep ad-hoc
 *     refunds for ticket 00618fac's customer live here), so we can never stack a second refund
 *     on top of June's manual one.
 *   - `refundOrder` is called with a stable `requestKey` so even a double-invocation can't
 *     double-fire at the gateway (belt-and-suspenders to the ledger guard above).
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` (writes a `pending` row to `public.data_op_runs` and
 * escalates any un-run row to the CEO inbox so the fleet-wide MONEY question gets explicit
 * authorization); the box worker's executor ([[../src/lib/ship-time-backfill-executor]]
 * `executeShipTimeBackfillsForSpec`) runs it and flips the row to `ran` / `failed`.
 *
 * Because the executor runs `npx tsx -- <script>` with NO `--apply`, the DEFAULT run is a
 * DRY-RUN that only prints the manifest — real money moves ONLY when a human, after reviewing
 * the manifest and the CEO authorization, re-runs it with `--apply`. This is deliberate: a
 * fleet-wide refund is hard to reverse (north star — hitting a money rail escalates, it does
 * not auto-execute).
 *
 *   npx tsx scripts/_backfill-renewal-free-shipping-refunds.ts            # dry-run (manifest only)
 *   npx tsx scripts/_backfill-renewal-free-shipping-refunds.ts --apply    # issue refunds (CEO-authorized)
 */
import { createAdminClient } from "./_bootstrap";
import { refundOrder } from "../src/lib/refund";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 500;
const REFUND_REASON =
  "Free-shipping guarantee backfill — refund wrongly-charged subscription renewal shipping + proportional tax (ticket 00618fac)";

interface PaymentDetails {
  subtotal_cents?: number;
  discount_cents?: number;
  shipping_cents?: number;
  protection_cents?: number;
  tax_cents?: number;
}

interface OrderRow {
  id: string;
  workspace_id: string;
  order_number: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  financial_status: string | null;
  shopify_order_id: string | null;
  braintree_transaction_id: string | null;
  payment_details: PaymentDetails | null;
}

interface WorkspaceGuarantee {
  on: boolean;
  thresholdCents: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Defect = shipping + the proportional tax that shipping contributed. Never product tax. */
export function computeShippingDefectCents(pd: PaymentDetails): { shipping: number; shippingTax: number; defect: number } {
  const shipping = num(pd.shipping_cents);
  if (shipping <= 0) return { shipping: 0, shippingTax: 0, defect: 0 };
  const net = Math.max(0, num(pd.subtotal_cents) - num(pd.discount_cents));
  const protection = num(pd.protection_cents);
  const tax = num(pd.tax_cents);
  const taxableBase = net + shipping + protection;
  const shippingTax = taxableBase > 0 && tax > 0 ? Math.round((tax * shipping) / taxableBase) : 0;
  return { shipping, shippingTax, defect: shipping + shippingTax };
}

async function main(): Promise<void> {
  const admin = createAdminClient();
  console.log(`renewal_free_shipping_refunds_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(
    "  matching: orders where source_name='internal_subscription_renewal' AND payment_details.shipping_cents > 0,\n" +
      "  in a workspace whose subscription free-shipping guarantee should have zeroed it.\n",
  );

  // Per-workspace guarantee cache (one read per distinct workspace).
  const wsCache = new Map<string, WorkspaceGuarantee>();
  async function guaranteeFor(workspaceId: string): Promise<WorkspaceGuarantee> {
    const hit = wsCache.get(workspaceId);
    if (hit) return hit;
    const { data: ws } = await admin
      .from("workspaces")
      .select("subscription_free_shipping, subscription_free_shipping_threshold_cents")
      .eq("id", workspaceId)
      .maybeSingle();
    const g: WorkspaceGuarantee = {
      on: !!ws?.subscription_free_shipping,
      thresholdCents: num(ws?.subscription_free_shipping_threshold_cents),
    };
    wsCache.set(workspaceId, g);
    return g;
  }

  let cursor: string | null = null;
  let scanned = 0;
  let refundable = 0;
  let refundableCents = 0;
  let alreadyRefunded = 0;
  let notRefundable = 0;
  let guaranteeOff = 0;
  let belowThreshold = 0;
  let noShipping = 0;
  let applied = 0;
  let appliedCents = 0;
  let failed = 0;

  for (;;) {
    let q = admin
      .from("orders")
      .select(
        "id, workspace_id, order_number, customer_id, subscription_id, financial_status, shopify_order_id, braintree_transaction_id, payment_details",
      )
      .eq("source_name", "internal_subscription_renewal")
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) {
      console.error(`orders read failed: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as OrderRow[];
    if (!rows.length) break;

    for (const o of rows) {
      scanned++;
      cursor = o.id;
      const pd = o.payment_details || {};
      const { shipping, shippingTax, defect } = computeShippingDefectCents(pd);
      if (shipping <= 0) {
        noShipping++;
        continue;
      }
      const g = await guaranteeFor(o.workspace_id);
      if (!g.on) {
        guaranteeOff++;
        continue;
      }
      const net = Math.max(0, num(pd.subtotal_cents) - num(pd.discount_cents));
      if (g.thresholdCents > 0 && net < g.thresholdCents) {
        belowThreshold++;
        continue; // shipping was legitimately charged — below the guarantee's minimum
      }

      // ── Already-refunded guard — never stack on a prior (ad-hoc) refund. ──
      const { data: priorRefund } = await admin
        .from("order_refunds")
        .select("id, amount_cents, status")
        .eq("workspace_id", o.workspace_id)
        .eq("order_id", o.id)
        .in("status", ["succeeded", "settled"])
        .limit(1)
        .maybeSingle();
      if (priorRefund) {
        alreadyRefunded++;
        console.log(
          `  [already_refunded] ${o.order_number ?? o.id} — prior refund exists (status=${priorRefund.status}); ` +
            `defect was $${(defect / 100).toFixed(2)} (ship $${(shipping / 100).toFixed(2)} + tax $${(shippingTax / 100).toFixed(2)}). Reconcile manually.`,
        );
        continue;
      }

      if (!o.shopify_order_id && !o.braintree_transaction_id) {
        notRefundable++;
        console.log(`  [not_refundable] ${o.order_number ?? o.id} — no Shopify order / Braintree txn to refund.`);
        continue;
      }

      refundable++;
      refundableCents += defect;
      console.log(
        `  [refundable] ${o.order_number ?? o.id} — $${(defect / 100).toFixed(2)} ` +
          `(ship $${(shipping / 100).toFixed(2)} + tax $${(shippingTax / 100).toFixed(2)})`,
      );

      if (APPLY) {
        const requestKey = `freeship-backfill:${o.id}:${defect}`;
        const res = await refundOrder(o.workspace_id, o.id, defect, REFUND_REASON, {
          source: "backfill",
          customerId: o.customer_id,
          requestKey,
          eventProperties: {
            backfill: "renewal_free_shipping_refunds",
            ticket: "00618fac-70a6-4395-9ee0-87a23b7d46cd",
            subscription_id: o.subscription_id,
            shipping_cents: shipping,
            shipping_tax_cents: shippingTax,
          },
        });
        if (res.success) {
          if (res.blockedDuplicate) {
            console.log(`    ↳ already issued (idempotent) — refund_id=${res.refund_id ?? "?"}`);
          } else {
            applied++;
            appliedCents += defect;
            console.log(`    ↳ refunded via ${res.method} — refund_id=${res.refund_id ?? "?"}`);
          }
        } else {
          failed++;
          console.error(`    ↳ FAILED: ${res.error}`);
        }
      }
    }

    if (rows.length < CHUNK) break;
  }

  console.log(
    `\nSummary (${APPLY ? "APPLY" : "DRY-RUN"}):\n` +
      `  scanned renewal orders:        ${scanned}\n` +
      `  no shipping charged:           ${noShipping}\n` +
      `  guarantee off (skipped):       ${guaranteeOff}\n` +
      `  below threshold (skipped):     ${belowThreshold}\n` +
      `  already refunded (skipped):    ${alreadyRefunded}\n` +
      `  not refundable (no gateway):   ${notRefundable}\n` +
      `  refundable defects:            ${refundable}  ($${(refundableCents / 100).toFixed(2)})`,
  );
  if (APPLY) {
    console.log(`  refunds issued:                ${applied}  ($${(appliedCents / 100).toFixed(2)})`);
    console.log(`  refunds failed:                ${failed}`);
  } else {
    console.log(`\n  DRY-RUN — no money moved. Re-run with --apply after CEO authorization to issue the refunds.`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`renewal_free_shipping_refunds_backfill crashed: ${errText(e)}`);
    process.exit(1);
  });
}
