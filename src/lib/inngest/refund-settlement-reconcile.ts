/**
 * refund-settlement-reconcile — the T+3d settlement backstop for the
 * order_refunds mirror ([[../tables/order_refunds]]).
 *
 * Daily cron. For every mirror row whose status is 'succeeded' and whose
 * requested_at is more than 3 days old, poll the vendor for authoritative
 * settled state:
 *   - Braintree → gateway.transaction.find(vendor_refund_id)
 *   - Shopify  → REST /admin/api/{ver}/orders/{shopify_order_id}/refunds/{refund_id}.json
 *
 * On the vendor confirming settlement (Braintree status='settled',
 * Shopify refund.transactions[0].status='success'), flip the mirror row
 * to status='settled' + settled_at=now(). Compare-and-set on status:
 * the WHERE clause carries `.eq('status','succeeded')` so a concurrent
 * flip (reversed, re-processed) can never be clobbered.
 *
 * On DRIFT — the vendor reports a different amount, doesn't recognize
 * the refund id, or reports it failed/voided — surface it. Two writes:
 *   1. A `dashboard_notifications` row of type='refund_drift' carrying
 *      the mirror row_id + both amounts + the reason, deduped so a
 *      re-tick can't spam-add cards. (We use dashboard_notifications
 *      rather than the spec's original `agent_todos` target because
 *      `agent_todos.action_type` was pruned to four customer-facing
 *      values in 20260620160100_agent_todos_prune_action_types.sql;
 *      the CHECK constraint refuses a `refund_drift` insert. The
 *      dashboard_notifications surface is the current pattern for
 *      manual-attention alerts — see fleet-spend-governor.ts,
 *      escalation.ts, daily-order-snapshot.ts.)
 *   2. A `ticket_messages` system-authored sysNote on the ticket that
 *      originally fired the refund, IF one exists — resolved via the
 *      `customer_events` row logCustomerEvent stamped at fire-time
 *      (properties.order_id + properties.ticket_id).
 *
 * See docs/brain/inngest/refund-settlement-reconcile.md and the parent
 * spec docs/brain/specs/refund-integrity-order-refunds-mirror-verify-by-id-settlement-reconcile.md.
 */
import { inngest } from "@/lib/inngest/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getBraintreeGateway } from "@/lib/integrations/braintree";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { decrypt } from "@/lib/crypto";
import { emitCronHeartbeat } from "@/lib/control-tower/heartbeat";

const AGED_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // T+3d
const BATCH_LIMIT = 200; // per-tick cap; a runaway backlog surfaces via the heartbeat count

type AdminClient = ReturnType<typeof createAdminClient>;

interface AgedRefundRow {
  id: string;
  workspace_id: string;
  order_id: string;
  vendor: string;
  vendor_refund_id: string | null;
  amount_cents: number;
  requested_at: string;
}

// One resolved verdict from a vendor lookup.
interface VendorVerdict {
  settled: boolean;             // vendor confirmed the refund settled at the same amount
  drift: boolean;               // vendor state disagrees with the mirror
  vendor_amount_cents: number | null; // amount vendor reports; null if unknown
  reason: string;               // human-readable summary for the drift ticket / heartbeat
}

async function reconcileBraintree(
  workspaceId: string,
  vendorRefundId: string,
  mirrorAmountCents: number,
): Promise<VendorVerdict> {
  try {
    const gateway = await getBraintreeGateway(workspaceId);
    // Braintree's `transaction.find(id)` returns the refund transaction
    // itself when we pass a refund's txn id (the id we stored is the
    // result.transaction.id from the refund call, not the parent sale).
    const txn = await gateway.transaction.find(vendorRefundId).catch(() => null);
    if (!txn) {
      return {
        settled: false,
        drift: true,
        vendor_amount_cents: null,
        reason: `Braintree does not recognize refund transaction ${vendorRefundId}`,
      };
    }
    const vendorAmountCents = txn.amount ? Math.round(Number(txn.amount) * 100) : null;
    if (vendorAmountCents !== null && vendorAmountCents !== mirrorAmountCents) {
      return {
        settled: false,
        drift: true,
        vendor_amount_cents: vendorAmountCents,
        reason: `Braintree amount ${(vendorAmountCents / 100).toFixed(2)} disagrees with mirror ${(mirrorAmountCents / 100).toFixed(2)}`,
      };
    }
    if (txn.status === "settled") {
      return { settled: true, drift: false, vendor_amount_cents: vendorAmountCents, reason: "Braintree status=settled" };
    }
    if (txn.status === "voided" || txn.status === "gateway_rejected" || txn.status === "failed" || txn.status === "processor_declined") {
      return {
        settled: false,
        drift: true,
        vendor_amount_cents: vendorAmountCents,
        reason: `Braintree status=${txn.status} — mirror says succeeded`,
      };
    }
    // Still in-flight (submitted_for_settlement, settling). Neither
    // settled nor drift yet — return a non-terminal verdict so we
    // leave the row alone and re-check next tick.
    return { settled: false, drift: false, vendor_amount_cents: vendorAmountCents, reason: `Braintree status=${txn.status}` };
  } catch (e) {
    // A single-row lookup failure isn't drift — surface it in the
    // reason but don't flip settled and don't open a drift ticket.
    return { settled: false, drift: false, vendor_amount_cents: null, reason: `Braintree lookup error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function reconcileShopify(
  admin: AdminClient,
  workspaceId: string,
  orderId: string,
  vendorRefundId: string,
  mirrorAmountCents: number,
): Promise<VendorVerdict> {
  try {
    // Need the shopify_order_id from our orders table + the workspace's
    // Shopify credentials to hit REST. Scoped to workspace so we can
    // never accidentally read another tenant's Shopify order.
    const { data: order } = await admin
      .from("orders")
      .select("shopify_order_id")
      .eq("id", orderId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (!order?.shopify_order_id) {
      return { settled: false, drift: false, vendor_amount_cents: null, reason: "Shopify order_id not on file — cannot poll refund state" };
    }
    const { data: ws } = await admin
      .from("workspaces")
      .select("shopify_myshopify_domain, shopify_access_token_encrypted")
      .eq("id", workspaceId)
      .maybeSingle();
    if (!ws?.shopify_myshopify_domain || !ws?.shopify_access_token_encrypted) {
      return { settled: false, drift: false, vendor_amount_cents: null, reason: "Shopify credentials missing on workspace" };
    }
    const token = decrypt(ws.shopify_access_token_encrypted);
    const url = `https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/orders/${order.shopify_order_id}/refunds/${vendorRefundId}.json`;
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (res.status === 404) {
      return { settled: false, drift: true, vendor_amount_cents: null, reason: `Shopify does not recognize refund id ${vendorRefundId}` };
    }
    if (!res.ok) {
      return { settled: false, drift: false, vendor_amount_cents: null, reason: `Shopify refund lookup HTTP ${res.status}` };
    }
    const refund = ((await res.json()) as { refund?: { transactions?: { status: string; amount: string }[] } }).refund;
    const tx = refund?.transactions?.[0];
    if (!tx) {
      return { settled: false, drift: true, vendor_amount_cents: null, reason: "Shopify refund carries no transaction" };
    }
    const vendorAmountCents = tx.amount ? Math.round(Number(tx.amount) * 100) : null;
    if (vendorAmountCents !== null && vendorAmountCents !== mirrorAmountCents) {
      return {
        settled: false,
        drift: true,
        vendor_amount_cents: vendorAmountCents,
        reason: `Shopify amount ${(vendorAmountCents / 100).toFixed(2)} disagrees with mirror ${(mirrorAmountCents / 100).toFixed(2)}`,
      };
    }
    if (tx.status === "success") {
      return { settled: true, drift: false, vendor_amount_cents: vendorAmountCents, reason: "Shopify refund tx.status=success" };
    }
    if (tx.status === "failure" || tx.status === "error") {
      return {
        settled: false,
        drift: true,
        vendor_amount_cents: vendorAmountCents,
        reason: `Shopify refund tx.status=${tx.status} — mirror says succeeded`,
      };
    }
    // pending — still in-flight
    return { settled: false, drift: false, vendor_amount_cents: vendorAmountCents, reason: `Shopify refund tx.status=${tx.status}` };
  } catch (e) {
    return { settled: false, drift: false, vendor_amount_cents: null, reason: `Shopify lookup error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Find the ticket that fired the refund. refundOrder stamps a
// customer_events row of event_type='order.refunded' with the
// ticket_id (when the caller supplied one) inside `properties`. Best
// effort — a system-fired refund (playbook, cron) may carry no ticket.
async function findLinkedTicketId(
  admin: AdminClient,
  workspaceId: string,
  orderId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("customer_events")
    .select("properties")
    .eq("workspace_id", workspaceId)
    .eq("event_type", "order.refunded")
    .contains("properties", { order_id: orderId })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const props = (data?.properties || {}) as Record<string, unknown>;
  const ticketId = props.ticket_id;
  return typeof ticketId === "string" && ticketId ? ticketId : null;
}

// Deduped drift-notification insert. The dedup guard is a check for an
// UNDISMISSED refund_drift card whose metadata.order_refund_id matches
// this row — a re-tick after ops sees the card must not spam a second.
async function openDriftNotification(
  admin: AdminClient,
  row: AgedRefundRow,
  verdict: VendorVerdict,
): Promise<{ opened: boolean; reason: string }> {
  const { data: existing } = await admin
    .from("dashboard_notifications")
    .select("id")
    .eq("workspace_id", row.workspace_id)
    .eq("type", "refund_drift")
    .eq("dismissed", false)
    .contains("metadata", { order_refund_id: row.id })
    .limit(1)
    .maybeSingle();
  if (existing) return { opened: false, reason: "already-open" };

  const { data: order } = await admin
    .from("orders")
    .select("order_number")
    .eq("id", row.order_id)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();

  const { error } = await admin.from("dashboard_notifications").insert({
    workspace_id: row.workspace_id,
    type: "refund_drift",
    title: `Refund drift on order #${order?.order_number ?? row.order_id.slice(0, 8)}`,
    body: `${verdict.reason}. Mirror row ${row.id}: $${(row.amount_cents / 100).toFixed(2)} via ${row.vendor} (${row.vendor_refund_id || "no vendor id"}).`,
    link: `/dashboard/orders/${row.order_id}`,
    metadata: {
      kind: "refund_drift",
      order_refund_id: row.id,
      order_id: row.order_id,
      vendor: row.vendor,
      vendor_refund_id: row.vendor_refund_id,
      amount_cents_mirror: row.amount_cents,
      amount_cents_vendor: verdict.vendor_amount_cents,
      reason: verdict.reason,
    },
  });
  return { opened: !error, reason: error ? `insert error: ${error.message}` : "opened" };
}

// System-authored ticket_messages sysNote on the ticket that originally
// fired the refund. Best-effort — no ticket linkage ⇒ silent skip.
async function attachSysNote(
  admin: AdminClient,
  workspaceId: string,
  row: AgedRefundRow,
  verdict: VendorVerdict,
): Promise<boolean> {
  const ticketId = await findLinkedTicketId(admin, workspaceId, row.order_id);
  if (!ticketId) return false;
  const body = `[Refund drift] ${verdict.reason}. Mirror: $${(row.amount_cents / 100).toFixed(2)} via ${row.vendor} (${row.vendor_refund_id || "no vendor id"})${verdict.vendor_amount_cents !== null ? `; vendor reports $${(verdict.vendor_amount_cents / 100).toFixed(2)}` : ""}.`;
  const { error } = await admin.from("ticket_messages").insert({
    ticket_id: ticketId,
    direction: "outbound",
    visibility: "internal",
    author_type: "system",
    body,
  });
  return !error;
}

export const refundSettlementReconcileCron = inngest.createFunction(
  {
    id: "refund-settlement-reconcile",
    name: "Refund-integrity — T+3d settlement reconcile",
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: "15 6 * * *" }], // 1:15 AM Central, right after daily-order-snapshot
  },
  async ({ step }) => {
    const startedAt = Date.now();

    const result = await step.run("reconcile-aged-refunds", async () => {
      const admin = createAdminClient();
      const cutoffIso = new Date(Date.now() - AGED_INTERVAL_MS).toISOString();

      // Enumerate over the ACTIVE set only — status='succeeded' with a
      // populated vendor_refund_id (an 'internal' refund has none and
      // can never be polled). Bounding the enumeration this way is the
      // guard against the fan-out coaching mistake: never iterate a raw
      // ledger match, always filter to the active-work slice.
      const { data: rows } = await admin
        .from("order_refunds")
        .select("id, workspace_id, order_id, vendor, vendor_refund_id, amount_cents, requested_at")
        .eq("status", "succeeded")
        .lt("requested_at", cutoffIso)
        .not("vendor_refund_id", "is", null)
        .in("vendor", ["braintree", "shopify"])
        .order("requested_at", { ascending: true })
        .limit(BATCH_LIMIT);

      let scanned = 0;
      let settledCount = 0;
      let driftCount = 0;
      let unchanged = 0;
      for (const row of (rows || []) as AgedRefundRow[]) {
        scanned++;
        const vendorId = row.vendor_refund_id;
        if (!vendorId) { unchanged++; continue; }

        const verdict = row.vendor === "braintree"
          ? await reconcileBraintree(row.workspace_id, vendorId, row.amount_cents)
          : await reconcileShopify(admin, row.workspace_id, row.order_id, vendorId, row.amount_cents);

        if (verdict.settled) {
          // Compare-and-set flip. status='succeeded' in the WHERE clause
          // is the invariant guard — a row that raced into 'reversed'
          // or was already flipped elsewhere is protected. The .select
          // asserts exactly one row transitioned (bail-silent if zero).
          const { data: updated } = await admin
            .from("order_refunds")
            .update({ status: "settled", settled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", row.id)
            .eq("workspace_id", row.workspace_id)
            .eq("status", "succeeded")
            .select("id");
          if (updated && updated.length === 1) {
            settledCount++;
          } else {
            unchanged++;
          }
          continue;
        }

        if (verdict.drift) {
          const opened = await openDriftNotification(admin, row, verdict);
          if (opened.opened) {
            driftCount++;
            await attachSysNote(admin, row.workspace_id, row, verdict).catch(() => {});
          } else {
            unchanged++;
          }
          continue;
        }

        // Non-terminal (in-flight or a soft lookup failure) — leave the
        // row alone and re-check on the next tick.
        unchanged++;
      }

      return { scanned, settled: settledCount, drift: driftCount, unchanged, cutoff: cutoffIso };
    });

    await step.run("emit-heartbeat", async () => {
      await emitCronHeartbeat("refund-settlement-reconcile", {
        ok: true,
        produced: result,
        detail: `${result.scanned} scanned · ${result.settled} settled · ${result.drift} drift · ${result.unchanged} unchanged`,
        durationMs: Date.now() - startedAt,
      });
    });

    return result;
  },
);
