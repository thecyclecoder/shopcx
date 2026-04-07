"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import Link from "next/link";

interface OrderDetail {
  id: string;
  order_number: string;
  email: string;
  total_cents: number;
  currency: string;
  financial_status: string;
  fulfillment_status: string;
  delivery_status?: string | null;
  line_items: { sku?: string; title?: string; quantity?: number; price_cents?: number }[] | null;
  created_at: string;
  tags: string | null;
  source_name: string | null;
  shopify_order_id: string;
  shopify_customer_id: string | null;
  subscription_id: string | null;
  shipping_address: {
    first_name?: string; last_name?: string;
    address1?: string; address2?: string;
    city?: string; province?: string; zip?: string; country?: string;
  } | null;
  discount_codes: string[] | null;
  sync_resolved_at: string | null;
  sync_resolved_note: string | null;
  easypost_status: string | null;
  easypost_detail: string | null;
  easypost_location: string | null;
  easypost_checked_at: string | null;
  amplifier_order_id: string | null;
  amplifier_received_at: string | null;
  amplifier_shipped_at: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  amplifier_status: string | null;
  fulfillments: { status?: string; createdAt?: string; trackingInfo?: { number?: string; company?: string; url?: string }[] }[] | null;
  customers: {
    id: string; email: string; first_name: string | null; last_name: string | null;
    phone: string | null; shopify_customer_id: string | null;
    retention_score: number | null; ltv_cents: number | null; total_orders: number | null;
  } | null;
}

interface TimelineEvent {
  timestamp: string;
  event: string;
  detail?: string;
}

const FINANCIAL_BADGE: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  refunded: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  partially_refunded: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  pending: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  voided: "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500",
};

const FULFILLMENT_BADGE: Record<string, string> = {
  delivered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  in_transit: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  returned: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  fulfilled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  partial: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  unfulfilled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function getShippingLabel(o: { fulfillment_status: string; delivery_status?: string | null }): string {
  const fs = (o.fulfillment_status || "").toUpperCase();
  const ds = o.delivery_status || "";
  if (ds === "delivered") return "delivered";
  if (ds === "returned") return "returned";
  if (fs === "FULFILLED" && ds === "not_delivered") return "in_transit";
  if (fs === "FULFILLED") return "in_transit";
  if (!fs || fs === "UNFULFILLED" || fs === "NULL") return "unfulfilled";
  return fs.toLowerCase();
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null): string {
  if (!d) return "--";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(d: string): string {
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

export default function OrderDetailPage() {
  const { id: orderId } = useParams<{ id: string }>();
  const workspace = useWorkspace();
  const router = useRouter();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [subscription, setSubscription] = useState<{ id: string; shopify_contract_id: string; status: string } | null>(null);
  const [shopifyDomain, setShopifyDomain] = useState("");
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [replacementOrder, setReplacementOrder] = useState<{ id: string; order_name: string; status: string } | null>(null);
  const [isReplacementFor, setIsReplacementFor] = useState<{ id: string; original_order: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolveNote, setResolveNote] = useState("");
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${workspace.id}/orders/${orderId}`)
      .then(r => r.json())
      .then(data => {
        setOrder(data.order || null);
        setSubscription(data.subscription || null);
        setShopifyDomain(data.shopify_domain || "");
        setTimeline(data.timeline || []);
        setReplacementOrder(data.replacement_order || null);
        setIsReplacementFor(data.is_replacement_for || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspace.id, orderId]);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Order not found.</p>
      </div>
    );
  }

  const customer = order.customers;
  const customerName = `${customer?.first_name || ""} ${customer?.last_name || ""}`.trim() || customer?.email || order.email || "";
  const addr = order.shipping_address;
  const items = order.line_items || [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <button onClick={() => router.push("/dashboard/orders")} className="mb-2 text-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          &larr; Back to Orders
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{order.order_number}</h1>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${FINANCIAL_BADGE[order.financial_status] || FINANCIAL_BADGE.pending}`}>
            {order.financial_status}
          </span>
          {(() => {
            const sl = getShippingLabel(order);
            return (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${FULFILLMENT_BADGE[sl] || FULFILLMENT_BADGE.unfulfilled}`}>
                {sl.replace("_", " ")}
              </span>
            );
          })()}
          {order.amplifier_status && (
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              Amplifier: {order.amplifier_status}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">{formatDateTime(order.created_at)}</p>
        {/* Replacement links */}
        {replacementOrder && (
          <div className="mt-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 dark:border-orange-800 dark:bg-orange-950">
            <span className="text-sm text-orange-700 dark:text-orange-400">
              Replacement order created: <button onClick={() => router.push(`/dashboard/orders?search=${replacementOrder.order_name}`)} className="font-medium underline">{replacementOrder.order_name}</button>
              <span className="ml-2 rounded bg-orange-100 px-1.5 py-0.5 text-xs dark:bg-orange-900/30">{replacementOrder.status}</span>
            </span>
          </div>
        )}
        {isReplacementFor && (
          <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-800 dark:bg-indigo-950">
            <span className="text-sm text-indigo-700 dark:text-indigo-400">
              This is a replacement for: <button onClick={() => router.push(`/dashboard/orders?search=${isReplacementFor.original_order}`)} className="font-medium underline">{isReplacementFor.original_order}</button>
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left column — order info */}
        <div className="space-y-6 lg:col-span-2">
          {/* Line items */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Items</h2>
            </div>
            <div className="divide-y divide-zinc-50 dark:divide-zinc-800/50">
              {items.map((item, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title || item.sku || "Item"}</p>
                    {item.sku && <p className="text-xs text-zinc-400">SKU: {item.sku}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">x{item.quantity || 1}</p>
                    {item.price_cents != null && (
                      <p className="text-xs text-zinc-400">{formatCents(item.price_cents)}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <div className="flex justify-between text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                <span>Total</span>
                <span>{formatCents(order.total_cents)}</span>
              </div>
              {order.discount_codes && order.discount_codes.length > 0 && (
                <p className="mt-1 text-xs text-zinc-400">Discounts: {order.discount_codes.join(", ")}</p>
              )}
            </div>
          </div>

          {/* Timeline */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Timeline</h2>
            </div>
            <div className="px-4 py-3">
              {timeline.length === 0 ? (
                <p className="text-sm text-zinc-400">No events yet.</p>
              ) : (
                <div className="relative space-y-0">
                  {timeline.map((evt, i) => (
                    <div key={i} className="relative flex gap-3 pb-4 last:pb-0">
                      {/* Timeline line */}
                      {i < timeline.length - 1 && (
                        <div className="absolute left-[7px] top-4 h-full w-px bg-zinc-200 dark:bg-zinc-700" />
                      )}
                      {/* Dot */}
                      <div className={`relative z-10 mt-1 h-4 w-4 flex-shrink-0 rounded-full border-2 ${
                        evt.event.includes("Shipped") || evt.event.includes("Fulfilled") || evt.event.includes("fulfilled")
                          ? "border-emerald-500 bg-emerald-100 dark:bg-emerald-900"
                          : evt.event.includes("refund")
                          ? "border-red-500 bg-red-100 dark:bg-red-900"
                          : "border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-800"
                      }`} />
                      {/* Content */}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{evt.event}</p>
                        {evt.detail && <p className="text-xs text-zinc-500">{evt.detail}</p>}
                        <p className="text-xs text-zinc-400">{formatDateTime(evt.timestamp)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right column — sidebar */}
        <div className="space-y-6">
          {/* Customer */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Customer</h2>
            </div>
            <div className="px-4 py-3">
              {customer ? (
                <div className="space-y-2">
                  <Link href={`/dashboard/customers/${customer.id}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                    {customerName}
                  </Link>
                  <p className="text-xs text-zinc-500">{customer.email}</p>
                  {customer.phone && <p className="text-xs text-zinc-500">{customer.phone}</p>}
                  {customer.retention_score != null && (
                    <p className="text-xs text-zinc-400">Retention: {customer.retention_score}/100</p>
                  )}
                  {customer.ltv_cents != null && (
                    <p className="text-xs text-zinc-400">LTV: {formatCents(customer.ltv_cents)}</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-zinc-400">{order.email || "Unknown"}</p>
              )}
            </div>
          </div>

          {/* Resolve Sync Error */}
          {!order.amplifier_order_id && !(order.fulfillment_status || "").toLowerCase().includes("fulfilled") && (
            <div className="rounded-lg border-2 border-red-300 bg-white dark:border-red-800 dark:bg-zinc-900">
              <div className="border-b border-red-200 px-4 py-3 dark:border-red-800">
                <h2 className="text-sm font-semibold text-red-700 dark:text-red-400">Sync Error</h2>
              </div>
              <div className="px-4 py-3">
                {order.sync_resolved_at ? (
                  <div>
                    <p className="text-sm text-emerald-600 dark:text-emerald-400">Resolved {formatDate(order.sync_resolved_at)}</p>
                    {order.sync_resolved_note && (
                      <p className="mt-1 text-xs text-zinc-500">{order.sync_resolved_note}</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-zinc-500">No Amplifier ID. Resolve to mark fulfilled in Shopify (no customer notification) and remove from sync errors.</p>
                    <input
                      type="text"
                      value={resolveNote}
                      onChange={e => setResolveNote(e.target.value)}
                      placeholder="Note (optional)"
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    />
                    <button
                      disabled={resolving}
                      onClick={async () => {
                        setResolving(true);
                        const res = await fetch(`/api/workspaces/${workspace.id}/orders/${orderId}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "resolve_sync", note: resolveNote }),
                        });
                        if (res.ok) {
                          setOrder(prev => prev ? { ...prev, sync_resolved_at: new Date().toISOString(), sync_resolved_note: resolveNote, fulfillment_status: "fulfilled" } : prev);
                        }
                        setResolving(false);
                      }}
                      className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      {resolving ? "Resolving..." : "Resolve & Mark Fulfilled"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Shipping Address */}
          {addr && (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Shipping Address</h2>
              </div>
              <div className="px-4 py-3 text-sm text-zinc-600 dark:text-zinc-400">
                {addr.first_name && <p>{addr.first_name} {addr.last_name}</p>}
                {addr.address1 && <p>{addr.address1}</p>}
                {addr.address2 && <p>{addr.address2}</p>}
                <p>{[addr.city, addr.province, addr.zip].filter(Boolean).join(", ")}</p>
                {addr.country && <p>{addr.country}</p>}
              </div>
            </div>
          )}

          {/* Tracking */}
          {(order.amplifier_tracking_number || (order.fulfillments && order.fulfillments.length > 0)) && (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Tracking</h2>
              </div>
              <div className="px-4 py-3 space-y-2">
                {order.amplifier_tracking_number && (
                  <div>
                    <p className="text-xs font-medium text-zinc-500">Amplifier</p>
                    <p className="font-mono text-sm text-zinc-700 dark:text-zinc-300">{order.amplifier_tracking_number}</p>
                    {order.amplifier_carrier && <p className="text-xs text-zinc-400">{order.amplifier_carrier}</p>}
                  </div>
                )}
                {order.fulfillments?.map((f, i) =>
                  f.trackingInfo?.map((t, j) => (
                    <div key={`${i}-${j}`}>
                      <p className="text-xs font-medium text-zinc-500">Shopify</p>
                      <p className="font-mono text-sm text-zinc-700 dark:text-zinc-300">{t.number}</p>
                      {t.company && <p className="text-xs text-zinc-400">{t.company}</p>}
                      {t.url && (
                        <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-600 hover:text-indigo-500">
                          Track package
                        </a>
                      )}
                    </div>
                  ))
                )}
                {/* EasyPost enhanced tracking */}
                {order.easypost_status && (
                  <div className="mt-2 rounded border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-700 dark:bg-zinc-800/50">
                    <p className="text-xs font-medium text-zinc-500">EasyPost</p>
                    <p className={`text-sm font-medium ${
                      order.easypost_status === "delivered" ? "text-emerald-600 dark:text-emerald-400"
                      : order.easypost_status === "return_to_sender" ? "text-red-600 dark:text-red-400"
                      : order.easypost_status === "failure" ? "text-red-600 dark:text-red-400"
                      : "text-blue-600 dark:text-blue-400"
                    }`}>
                      {order.easypost_status.replace(/_/g, " ")}
                    </p>
                    {order.easypost_detail && (
                      <p className="text-xs text-zinc-500">{order.easypost_detail}</p>
                    )}
                    {order.easypost_location && (
                      <p className="text-xs text-zinc-400">{order.easypost_location}</p>
                    )}
                    {order.easypost_checked_at && (
                      <p className="text-[10px] text-zinc-400 mt-1">
                        Checked {new Date(order.easypost_checked_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Subscription */}
          {subscription && (
            <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Subscription</h2>
              </div>
              <div className="px-4 py-3">
                <Link href={`/dashboard/subscriptions/${subscription.id}`} className="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400">
                  Contract {subscription.shopify_contract_id}
                </Link>
                <p className="mt-1 text-xs text-zinc-400">Status: {subscription.status}</p>
              </div>
            </div>
          )}

          {/* External Links */}
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">External</h2>
            </div>
            <div className="px-4 py-3 space-y-2">
              {shopifyDomain && order.shopify_order_id && (
                <a href={`https://${shopifyDomain}/admin/orders/${order.shopify_order_id}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  View in Shopify
                </a>
              )}
              {order.amplifier_order_id && (
                <a href={`https://my.amplifier.com/orders/${order.amplifier_order_id}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200">
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.29 7 12 12 20.71 7" /><line x1="12" y1="22" x2="12" y2="12" />
                  </svg>
                  View in Amplifier
                </a>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
