"use client";

import React, { useState } from "react";
import StatusBadge from "./StatusBadge";
import { formatCents, formatDate } from "./format-utils";

export interface OrderLineItem {
  title: string;
  quantity: number;
  price_cents: number;
  sku: string | null;
}

export interface OrderFulfillment {
  trackingInfo: { number: string; url: string | null; company: string | null }[];
  status: string | null;
  createdAt: string | null;
}

export interface OrderRow {
  id: string;
  shopify_order_id?: string;
  order_number: string | null;
  total_cents: number;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  delivery_status?: string | null;
  source_name: string | null;
  order_type: string | null;
  tags?: string | null;
  line_items: OrderLineItem[] | null;
  fulfillments: OrderFulfillment[] | null;
  created_at: string;
}

/** Compute a human-friendly shipping status from fulfillment + delivery status */
function getShippingStatus(o: OrderRow): string {
  const fs = (o.fulfillment_status || "").toUpperCase();
  const ds = (o.delivery_status || "").toLowerCase();

  if (!fs || fs === "UNFULFILLED" || fs === "NULL") return "unfulfilled";
  if (ds === "delivered") return "delivered";
  if (ds === "returned") return "returned";
  if (ds === "out_for_delivery") return "in_transit";
  // Any fulfilled order that isn't delivered/returned is in transit
  if (fs === "FULFILLED") return "in_transit";
  return fs.toLowerCase();
}

interface OrdersTableProps {
  orders: OrderRow[];
  /** Title shown above the table */
  title?: string;
  /** Show count in the title */
  showCount?: boolean;
  /** Wrap the table in a card border (for subscription detail) */
  cardWrapper?: boolean;
  /** Text size for expanded detail items: "sm" for customer detail, "xs" for subscription detail */
  detailTextSize?: "sm" | "xs";
}

/**
 * Expandable orders table used on customer detail and subscription detail pages.
 * Each row expands to show order type, fulfillments, tracking, and line items.
 */
export default function OrdersTable({
  orders,
  title = "Recent Orders",
  showCount = false,
  cardWrapper = false,
  detailTextSize = "sm",
}: OrdersTableProps) {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const tableContent = (
    <>
      {cardWrapper && (
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}{showCount ? ` (${orders.length})` : ""}
          </h3>
        </div>
      )}
      {orders.length === 0 ? (
        <p className={`${cardWrapper ? "px-5 py-8" : "px-4 py-8"} text-center text-sm text-zinc-400`}>No orders found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className={`${cardWrapper ? "w-full" : "min-w-full"} divide-y divide-zinc-200 dark:divide-zinc-800`}>
            <thead>
              <tr className={`text-left ${detailTextSize === "xs" ? "text-xs" : "text-sm"} font-medium uppercase tracking-wider text-zinc-${detailTextSize === "xs" ? "400" : "500"}`}>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Order</th>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Type</th>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Date</th>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Total</th>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Payment</th>
                <th className={`px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"}`}>Fulfillment</th>
              </tr>
            </thead>
            <tbody className={`divide-y ${detailTextSize === "xs" ? "divide-zinc-100" : "divide-zinc-200"} dark:divide-zinc-800`}>
              {orders.map((o) => (
                <React.Fragment key={o.id}>
                  <tr
                    onClick={() => setSelectedOrderId(selectedOrderId === o.id ? null : o.id)}
                    className="cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} ${detailTextSize === "xs" ? "text-sm" : "text-sm"} font-medium text-zinc-900 dark:text-zinc-100`}>
                      <div className="flex items-center gap-1.5">
                        <svg
                          className={`h-3 w-3 text-zinc-400 transition-transform ${selectedOrderId === o.id ? "rotate-90" : ""}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        {cardWrapper ? `#${o.order_number || o.shopify_order_id || "--"}` : (o.order_number || "--")}
                      </div>
                    </td>
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} text-sm`}>
                      <OrderTypeBadge type={o.order_type} sourceName={o.source_name} size={detailTextSize} />
                    </td>
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} text-${detailTextSize === "xs" ? "sm" : "sm"} text-zinc-500`}>
                      {formatDate(o.created_at)}
                    </td>
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} text-sm text-zinc-700 dark:text-zinc-300`}>
                      {o.total_cents != null ? formatCents(o.total_cents, o.currency) : "--"}
                    </td>
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} text-sm`}>
                      <StatusBadge status={o.financial_status} size={detailTextSize} />
                    </td>
                    <td className={`whitespace-nowrap px-4 ${detailTextSize === "xs" ? "py-2.5" : "py-3"} text-sm`}>
                      <StatusBadge status={getShippingStatus(o)} size={detailTextSize} />
                    </td>
                  </tr>

                  {/* Expanded order detail */}
                  {selectedOrderId === o.id && (
                    <tr>
                      <td colSpan={6} className="bg-zinc-50 px-4 py-4 dark:bg-zinc-800/30">
                        <div className="space-y-3">
                          {/* Order meta */}
                          <div className={`flex flex-wrap gap-4 text-${detailTextSize} text-zinc-500`}>
                            {o.source_name && (
                              <span>Source: <span className="font-medium text-zinc-700 dark:text-zinc-300">{o.source_name}</span></span>
                            )}
                            {o.tags && (
                              <span>Tags: <span className="font-medium text-zinc-700 dark:text-zinc-300">{o.tags}</span></span>
                            )}
                          </div>

                          {/* Fulfillment & Tracking */}
                          {o.fulfillments && o.fulfillments.length > 0 && (
                            <div className="space-y-1.5">
                              {o.fulfillments.map((f, fi) => (
                                <div key={fi} className={`flex flex-wrap items-center gap-2 text-${detailTextSize}`}>
                                  <span className={`rounded-full px-2 py-0.5 font-medium ${
                                    f.status === "SUCCESS" || f.status === "success"
                                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                      : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                  }`}>
                                    {f.status || "Pending"}
                                  </span>
                                  {f.trackingInfo?.map((t, ti) => (
                                    <span key={ti} className="flex items-center gap-1">
                                      {t.company && <span className="text-zinc-400">{t.company}:</span>}
                                      {t.url ? (
                                        <a
                                          href={t.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="font-mono text-indigo-600 hover:underline dark:text-indigo-400"
                                        >
                                          {t.number}
                                        </a>
                                      ) : (
                                        <span className="font-mono text-zinc-600 dark:text-zinc-300">{t.number}</span>
                                      )}
                                    </span>
                                  ))}
                                  {f.createdAt && (
                                    <span className="text-zinc-400">{formatDate(f.createdAt)}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Line items */}
                          {o.line_items && o.line_items.length > 0 ? (
                            <div>
                              <p className={`mb-2 text-${detailTextSize} font-medium uppercase ${detailTextSize === "xs" ? "text-zinc-500" : "tracking-wider text-zinc-500"}`}>Items</p>
                              <div className="divide-y divide-zinc-200 rounded border border-zinc-200 bg-white dark:divide-zinc-700 dark:border-zinc-700 dark:bg-zinc-900">
                                {o.line_items.map((item, idx) => (
                                  <div key={idx} className="flex items-center justify-between px-3 py-2">
                                    <div>
                                      <p className="text-sm text-zinc-900 dark:text-zinc-100">{item.title}</p>
                                      {item.sku && (
                                        <p className="text-xs text-zinc-400">SKU: {item.sku}</p>
                                      )}
                                    </div>
                                    <div className="text-right">
                                      <p className="text-sm text-zinc-700 dark:text-zinc-300">
                                        {item.quantity} {detailTextSize === "xs" ? "x" : "\u00d7"} {formatCents(item.price_cents)}
                                      </p>
                                      <p className="text-xs text-zinc-400">
                                        {formatCents(item.quantity * item.price_cents)}
                                      </p>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm text-zinc-400">No line items available.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );

  if (cardWrapper) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {tableContent}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {tableContent}
    </div>
  );
}

function OrderTypeBadge({ type, sourceName, size }: { type: string | null; sourceName: string | null; size: "xs" | "sm" }) {
  const textSize = size === "xs" ? "text-xs" : "text-sm";

  if (type === "recurring") {
    return <span className={`rounded-full bg-violet-100 px-2 py-0.5 ${textSize} font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-400`}>Recurring</span>;
  }
  if (type === "checkout") {
    return <span className={`rounded-full bg-emerald-100 px-2 py-0.5 ${textSize} font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400`}>Checkout</span>;
  }
  if (type === "replacement") {
    return <span className={`rounded-full bg-orange-100 px-2 py-0.5 ${textSize} font-medium text-orange-700 dark:bg-orange-900/30 dark:text-orange-400`}>Replacement</span>;
  }
  return (
    <span className={`rounded-full bg-zinc-100 px-2 py-0.5 ${textSize} font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400`}>
      {sourceName || "--"}
    </span>
  );
}
