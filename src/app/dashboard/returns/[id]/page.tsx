"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface ReturnDetail {
  id: string;
  order_number: string;
  shopify_order_gid: string;
  status: string;
  resolution_type: string;
  source: string;
  order_total_cents: number;
  label_cost_cents: number;
  net_refund_cents: number;
  tracking_number: string | null;
  carrier: string | null;
  label_url: string | null;
  return_line_items: { title?: string; quantity?: number; shopify_fulfillment_line_item_id?: string }[];
  shipped_at: string | null;
  delivered_at: string | null;
  processed_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
  customer_id: string | null;
  order_id: string | null;
  ticket_id: string | null;
  customers: { id: string; email: string; first_name: string | null; last_name: string | null; shopify_customer_id: string | null; retention_score: number | null; ltv_cents: number | null } | null;
  orders: { id: string; order_number: string | null; total_cents: number | null; financial_status: string | null; fulfillment_status: string | null; line_items: { title: string; quantity: number; price_cents: number }[]; created_at: string } | null;
  tickets: { id: string; subject: string | null; status: string; channel: string } | null;
}

const STATUS_BADGE: Record<string, { label: string; classes: string }> = {
  pending: { label: "Pending", classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  open: { label: "Open", classes: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  label_created: { label: "Label Sent", classes: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  in_transit: { label: "In Transit", classes: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  delivered: { label: "Delivered", classes: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
  processing: { label: "Processing", classes: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400" },
  restocked: { label: "Restocked", classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  refunded: { label: "Refunded", classes: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  closed: { label: "Closed", classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  cancelled: { label: "Cancelled", classes: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" },
};

const RESOLUTION_LABELS: Record<string, string> = {
  store_credit_return: "Store Credit (return)",
  refund_return: "Refund (return)",
  store_credit_no_return: "Store Credit (no return)",
  refund_no_return: "Refund (no return)",
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function RetentionBadge({ score }: { score: number }) {
  const color = score >= 70 ? "text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/20"
    : score >= 40 ? "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/20"
    : "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/20";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{score}</span>;
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const workspace = useWorkspace();
  const router = useRouter();

  const [ret, setRet] = useState<ReturnDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  // Tracking modal
  const [showTrackingModal, setShowTrackingModal] = useState(false);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingCarrier, setTrackingCarrier] = useState("USPS");

  const fetchReturn = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/returns/${id}`);
    if (res.ok) {
      setRet(await res.json());
    }
    setLoading(false);
  }, [workspace.id, id]);

  useEffect(() => { fetchReturn(); }, [fetchReturn]);

  const doAction = async (action: string, body?: Record<string, unknown>) => {
    setActing(action);
    try {
      let url = `/api/workspaces/${workspace.id}/returns/${id}`;
      let method = "PATCH";
      let payload = body || {};

      if (action === "approve") {
        url += "/approve";
        method = "POST";
        payload = {};
      } else if (action === "decline") {
        url += "/decline";
        method = "POST";
        payload = { declineReason: "FINAL_SALE" };
      } else if (action === "dispose_restocked" || action === "dispose_missing") {
        url += "/dispose";
        method = "POST";
        payload = { disposition: action === "dispose_restocked" ? "RESTOCKED" : "MISSING" };
      } else if (action === "refund" || action === "store_credit") {
        url += "/refund";
        method = "POST";
        payload = { method: action === "refund" ? "shopify_refund" : "store_credit" };
      } else if (action === "cancel") {
        payload = { status: "cancelled" };
      } else if (action === "add_tracking") {
        payload = { trackingNumber: trackingNumber, carrier: trackingCarrier };
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setShowTrackingModal(false);
        setTrackingNumber("");
        await fetchReturn();
      } else {
        const err = await res.json();
        alert(err.error || "Action failed");
      }
    } catch {
      alert("Action failed");
    }
    setActing(null);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-20 text-zinc-400">Loading...</div>;
  }

  if (!ret) {
    return <div className="flex items-center justify-center py-20 text-zinc-400">Return not found</div>;
  }

  const badge = STATUS_BADGE[ret.status] || STATUS_BADGE.pending;
  const customer = ret.customers;
  const order = ret.orders;
  const ticket = ret.tickets;

  // Build timeline events
  const timeline: { time: string; label: string }[] = [];
  timeline.push({ time: ret.created_at, label: `Return created (source: ${ret.source})` });
  if (ret.tracking_number) {
    const trackTime = ret.shipped_at || ret.created_at;
    timeline.push({ time: trackTime, label: `Tracking added: ${ret.carrier || ""}  ${ret.tracking_number}` });
  }
  if (ret.shipped_at) {
    timeline.push({ time: ret.shipped_at, label: "Shipped / In transit" });
  }
  if (ret.delivered_at) {
    timeline.push({ time: ret.delivered_at, label: "Delivered to warehouse" });
  }
  if (ret.processed_at) {
    timeline.push({ time: ret.processed_at, label: `Items ${ret.status === "restocked" || ret.refunded_at ? "restocked" : "processed"}` });
  }
  if (ret.refunded_at) {
    timeline.push({ time: ret.refunded_at, label: `${ret.resolution_type.startsWith("store_credit") ? "Store credit" : "Refund"} of ${formatCents(ret.net_refund_cents)} issued` });
  }
  if (ret.status === "closed" && !ret.refunded_at) {
    timeline.push({ time: ret.updated_at, label: "Return closed" });
  }
  if (ret.status === "cancelled") {
    timeline.push({ time: ret.updated_at, label: "Return cancelled" });
  }
  // Deduplicate and sort
  const seen = new Set<string>();
  const uniqueTimeline = timeline.filter(t => {
    const key = t.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <button onClick={() => router.push("/dashboard/returns")}
          className="mb-3 flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Returns
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Return — {ret.order_number}</h1>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.classes}`}>{badge.label}</span>
          <span className="text-sm text-zinc-500">{RESOLUTION_LABELS[ret.resolution_type] || ret.resolution_type}</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium capitalize text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{ret.source}</span>
        </div>
        <p className="mt-1 text-xs text-zinc-400">Created {formatDate(ret.created_at)}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column */}
        <div className="space-y-6 lg:col-span-2">

          {/* Financial Summary */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Financial Summary</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Order Total</span>
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{formatCents(ret.order_total_cents)}</span>
              </div>
              {ret.label_cost_cents > 0 && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Label Cost</span>
                  <span className="font-medium text-red-500">-{formatCents(ret.label_cost_cents)}</span>
                </div>
              )}
              <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <div className="flex justify-between">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">Net Refund</span>
                  <span className="font-bold text-zinc-900 dark:text-zinc-100">{formatCents(ret.net_refund_cents)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Return Items */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Return Items</h3>
            {ret.return_line_items.length > 0 ? (
              <div className="space-y-2">
                {ret.return_line_items.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-800">
                    <div>
                      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{item.title || "Item"}</p>
                      <p className="text-xs text-zinc-400">Qty: {item.quantity || 1}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-400">No line items</p>
            )}
          </div>

          {/* Timeline */}
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Timeline</h3>
            <div className="space-y-0">
              {uniqueTimeline.map((evt, idx) => (
                <div key={idx} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    {idx < uniqueTimeline.length - 1 && <div className="w-px flex-1 bg-zinc-200 dark:bg-zinc-700" />}
                  </div>
                  <div className="pb-4">
                    <p className="text-sm text-zinc-700 dark:text-zinc-300">{evt.label}</p>
                    <p className="mt-0.5 text-xs text-zinc-400">{formatDate(evt.time)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          {!["closed", "cancelled"].includes(ret.status) && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Actions</h3>
              <div className="space-y-2">
                {/* Approve / Decline — for pending returns (customer-initiated) */}
                {ret.status === "pending" && (
                  <>
                    <button onClick={() => { if (confirm("Approve this return request?")) doAction("approve"); }} disabled={!!acting}
                      className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
                      {acting === "approve" ? "Approving..." : "Approve Return"}
                    </button>
                    <button onClick={() => { if (confirm("Decline this return request? The customer will be notified.")) doAction("decline"); }} disabled={!!acting}
                      className="w-full rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50">
                      {acting === "decline" ? "Declining..." : "Decline Return"}
                    </button>
                  </>
                )}

                {/* Add Tracking — for open or label_created without tracking */}
                {["open", "label_created"].includes(ret.status) && !ret.tracking_number && (
                  <button onClick={() => setShowTrackingModal(true)} disabled={!!acting}
                    className="w-full rounded-md border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-400">
                    Add Tracking
                  </button>
                )}

                {/* Mark Restocked / Mark Missing — for delivered or processing */}
                {["delivered", "processing"].includes(ret.status) && (
                  <>
                    <button onClick={() => { if (confirm("Mark items as restocked?")) doAction("dispose_restocked"); }} disabled={!!acting}
                      className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50">
                      {acting === "dispose_restocked" ? "Restocking..." : "Mark as Restocked"}
                    </button>
                    <button onClick={() => { if (confirm("Mark items as missing?")) doAction("dispose_missing"); }} disabled={!!acting}
                      className="w-full rounded-md border border-amber-300 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-700 dark:text-amber-400">
                      {acting === "dispose_missing" ? "Processing..." : "Mark as Missing"}
                    </button>
                  </>
                )}

                {/* Issue Refund / Store Credit — for restocked */}
                {ret.status === "restocked" && (
                  <>
                    <button onClick={() => { if (confirm(`Issue Shopify refund of ${formatCents(ret.net_refund_cents)}?`)) doAction("refund"); }} disabled={!!acting}
                      className="w-full rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50">
                      {acting === "refund" ? "Processing..." : `Issue Refund (${formatCents(ret.net_refund_cents)})`}
                    </button>
                    <button onClick={() => { if (confirm(`Issue store credit of ${formatCents(ret.net_refund_cents)}?`)) doAction("store_credit"); }} disabled={!!acting}
                      className="w-full rounded-md border border-emerald-300 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-700 dark:text-emerald-400">
                      {acting === "store_credit" ? "Processing..." : `Issue Store Credit (${formatCents(ret.net_refund_cents)})`}
                    </button>
                  </>
                )}

                {/* Close — for refunded */}
                {ret.status === "refunded" && (
                  <button onClick={() => { if (confirm("Close this return?")) doAction("close"); }} disabled={!!acting}
                    className="w-full rounded-md bg-zinc-500 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50">
                    {acting === "close" ? "Closing..." : "Close Return"}
                  </button>
                )}

                {/* Cancel — for open, label_created, pending */}
                {["open", "label_created", "pending"].includes(ret.status) && (
                  <button onClick={() => { if (confirm("Cancel this return?")) doAction("cancel"); }} disabled={!!acting}
                    className="w-full rounded-md border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400">
                    {acting === "cancel" ? "Cancelling..." : "Cancel Return"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Column */}
        <div className="space-y-4">

          {/* Order Info */}
          {order && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Order Info</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Order</span>
                  <Link href={`/dashboard/orders?search=${order.order_number}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    {order.order_number}
                  </Link>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Date</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{formatDate(order.created_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Total</span>
                  <span className="text-zinc-700 dark:text-zinc-300">{order.total_cents ? formatCents(order.total_cents) : "--"}</span>
                </div>
                {order.financial_status && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Financial</span>
                    <span className="capitalize text-zinc-700 dark:text-zinc-300">{order.financial_status}</span>
                  </div>
                )}
                {order.fulfillment_status && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Fulfillment</span>
                    <span className="capitalize text-zinc-700 dark:text-zinc-300">{order.fulfillment_status}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Customer Card */}
          {customer && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customer</h3>
                {customer.retention_score != null && <RetentionBadge score={customer.retention_score} />}
              </div>
              <div className="space-y-2 text-sm">
                <div>
                  <Link href={`/dashboard/customers/${customer.id}`} className="font-medium text-indigo-600 hover:underline dark:text-indigo-400">
                    {customer.first_name || ""} {customer.last_name || ""}
                  </Link>
                </div>
                <div className="text-zinc-500">{customer.email}</div>
                {customer.ltv_cents != null && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">LTV</span>
                    <span className="text-zinc-700 dark:text-zinc-300">{formatCents(customer.ltv_cents)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Linked Ticket */}
          {ticket && (
            <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h3 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Linked Ticket</h3>
              <Link href={`/dashboard/tickets/${ticket.id}`}
                className="block rounded-md border border-zinc-200 p-3 transition-colors hover:border-indigo-200 hover:bg-indigo-50/50 dark:border-zinc-700 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{ticket.subject || "(no subject)"}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    ticket.status === "open" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                    : ticket.status === "pending" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  }`}>{ticket.status}</span>
                  <span className="text-xs capitalize text-zinc-400">{ticket.channel}</span>
                </div>
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* Tracking Modal */}
      {showTrackingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-zinc-900">
            <h3 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Add Tracking</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-sm text-zinc-500">Tracking Number</label>
                <input type="text" value={trackingNumber} onChange={e => setTrackingNumber(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  placeholder="9400111899223456789012" />
              </div>
              <div>
                <label className="mb-1 block text-sm text-zinc-500">Carrier</label>
                <select value={trackingCarrier} onChange={e => setTrackingCarrier(e.target.value)}
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
                  <option value="USPS">USPS</option>
                  <option value="UPS">UPS</option>
                  <option value="FedEx">FedEx</option>
                  <option value="DHL">DHL</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowTrackingModal(false)}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700 dark:text-zinc-300">Cancel</button>
              <button onClick={() => doAction("add_tracking")} disabled={!trackingNumber.trim() || !!acting}
                className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
                {acting === "add_tracking" ? "Saving..." : "Save Tracking"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
