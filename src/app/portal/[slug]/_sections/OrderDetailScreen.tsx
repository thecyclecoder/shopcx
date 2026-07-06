"use client";

/**
 * Order detail screen — customer-facing view of a single order.
 *
 * Read-only. Backed by /api/portal?route=orderDetail (the thin portal
 * handler that wraps the commerce SDK detail op). Renders order number,
 * placed date, honest slice-1 status, line items with images, totals,
 * tracking link when present, and shipping address.
 */

import { useCallback, useEffect, useState } from "react";
import { deliveryStatusTag, financialTag, type OrderStatusTag } from "./order-status";

interface OrderLine {
  variant_id: string | null;
  product_id: string | null;
  title: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
  variant_title?: string | null;
  image_url?: string | null;
  is_gift?: boolean;
}

interface OrderDetail {
  id: string;
  order_number: string;
  created_at: string;
  delivered_at: string | null;
  currency: string;
  financial_status: string | null;
  fulfillment_status: string | null;
  shopify_order_id: string | null;
  easypost_status: string | null;
  total_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  shipping_protection_added: boolean;
  shipping_protection_amount_cents: number;
  line_items: OrderLine[];
  tracking_number: string | null;
  carrier: string | null;
  amplifier_status: string | null;
  amplifier_tracking_number: string | null;
  amplifier_shipped_at: string | null;
  shipping_address: {
    first_name?: string;
    last_name?: string;
    address1?: string;
    address2?: string | null;
    city?: string;
    province_code?: string;
    province?: string;
    zip?: string;
    country?: string;
  } | null;
  discount_codes: Array<{ code?: string; amount?: string | number }>;
}

const TONE_CLASS: Record<OrderStatusTag["tone"], string> = {
  emerald: "bg-emerald-50 text-emerald-700",
  sky: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-800",
  zinc: "bg-zinc-100 text-zinc-600",
};

function fmtCents(c: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : "";
  return `${symbol}${(c / 100).toFixed(2)}`;
}

function trackingUrl(carrier: string | null, tracking: string): string | null {
  if (!tracking) return null;
  const c = (carrier || "").toLowerCase();
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`;
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?tracknumbers=${encodeURIComponent(tracking)}`;
  if (c.includes("dhl")) return `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(tracking)}`;
  return `https://www.google.com/search?q=${encodeURIComponent(tracking)}+tracking`;
}

interface Props {
  orderId: string;
}

export function OrderDetailScreen({ orderId }: Props) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOrder = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal?route=orderDetail&id=${encodeURIComponent(orderId)}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Could not load order");
      }
      const data = await res.json();
      if (!data.order) throw new Error("Order not found");
      setOrder(data.order as OrderDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    void loadOrder();
  }, [loadOrder]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-zinc-100" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />
      </div>
    );
  }
  if (error || !order) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <p className="text-sm font-semibold text-rose-800">Couldn&apos;t load this order</p>
        <p className="mt-1 text-xs text-rose-700">{error || "Unknown error"}</p>
        <a
          href="/orders"
          onClick={(e) => { e.preventDefault(); window.location.href = "/orders"; }}
          className="mt-3 inline-block text-sm font-semibold text-rose-700 underline"
        >
          ← Back to orders
        </a>
      </div>
    );
  }

  const delivery = deliveryStatusTag(order, Date.now());
  const financial = financialTag(order);
  const realItems = order.line_items.filter((l) => !l.is_gift);
  const placedDate = new Date(order.created_at).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const trackUrl = order.tracking_number ? trackingUrl(order.carrier, order.tracking_number) : null;

  return (
    <div className="space-y-5">
      <a
        href="/orders"
        onClick={(e) => { e.preventDefault(); window.location.href = "/orders"; }}
        className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        All orders
      </a>

      {/* Header */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="flex flex-col gap-2 border-b border-zinc-100 p-5 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Order</p>
              <span className="text-lg font-semibold text-zinc-900">{order.order_number}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[delivery.tone]}`}>
                {delivery.label}
              </span>
              {financial && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[financial.tone]}`}>
                  {financial.label}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500">Placed {placedDate}</p>
          </div>
          <div className="text-left text-sm sm:text-right">
            <div className="text-xs uppercase tracking-wider text-zinc-500">Total</div>
            <div className="mt-0.5 text-lg font-semibold text-zinc-900">{fmtCents(order.total_cents, order.currency)}</div>
          </div>
        </header>
      </article>

      {/* Items */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 p-5">
          <h3 className="text-base font-semibold text-zinc-900">Items</h3>
          <p className="mt-0.5 text-sm text-zinc-500">What&apos;s in this order.</p>
        </header>
        <ul className="divide-y divide-zinc-100">
          {order.line_items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 p-4 sm:px-5">
              {it.image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image_url} alt={it.title} className="h-14 w-14 flex-shrink-0 rounded-md object-cover" />
              ) : (
                <div className="h-14 w-14 flex-shrink-0 rounded-md bg-zinc-100" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-900">
                  {it.title}
                  {it.variant_title && it.variant_title !== "Default Title" && (
                    <span className="text-zinc-500"> — {it.variant_title}</span>
                  )}
                  {it.is_gift && (
                    <span className="ml-2 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                      Free gift
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">Qty {it.quantity}</div>
              </div>
              {it.is_gift ? (
                <div className="text-sm text-zinc-700">Free</div>
              ) : it.total_cents > 0 ? (
                <div className="text-sm text-zinc-700">{fmtCents(it.total_cents, order.currency)}</div>
              ) : null}
            </li>
          ))}
        </ul>
      </article>

      {/* Order summary */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="border-b border-zinc-100 p-5">
          <h3 className="text-base font-semibold text-zinc-900">Order summary</h3>
        </header>
        <div className="space-y-2 p-5 text-sm">
          <div className="flex items-center justify-between text-zinc-700">
            <span>Subtotal ({realItems.length} {realItems.length === 1 ? "item" : "items"})</span>
            <span>{fmtCents(order.subtotal_cents, order.currency)}</span>
          </div>
          {order.discount_cents > 0 && (
            <div className="flex items-center justify-between text-zinc-700">
              <span>Discount</span>
              <span>−{fmtCents(order.discount_cents, order.currency)}</span>
            </div>
          )}
          {order.shipping_cents > 0 && (
            <div className="flex items-center justify-between text-zinc-700">
              <span>Shipping</span>
              <span>{fmtCents(order.shipping_cents, order.currency)}</span>
            </div>
          )}
          {order.shipping_protection_added && order.shipping_protection_amount_cents > 0 && (
            <div className="flex items-center justify-between text-zinc-700">
              <span>Shipping protection</span>
              <span>{fmtCents(order.shipping_protection_amount_cents, order.currency)}</span>
            </div>
          )}
          {order.tax_cents > 0 && (
            <div className="flex items-center justify-between text-zinc-700">
              <span>Tax</span>
              <span>{fmtCents(order.tax_cents, order.currency)}</span>
            </div>
          )}
          <div className="mt-2 flex items-center justify-between border-t border-zinc-100 pt-3 text-base font-semibold text-zinc-900">
            <span>Total</span>
            <span>{fmtCents(order.total_cents, order.currency)}</span>
          </div>
        </div>
      </article>

      {/* Tracking */}
      {order.tracking_number && (
        <article className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
          <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
            Tracking{order.carrier ? ` (${order.carrier})` : ""}
          </div>
          <div className="mt-1 font-mono">{order.tracking_number}</div>
          {trackUrl && (
            <a
              href={trackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm font-semibold underline-offset-2 hover:underline"
            >
              Track package →
            </a>
          )}
        </article>
      )}

      {/* Shipping address */}
      {order.shipping_address && (
        <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Shipping address</div>
          <div className="mt-2 text-sm leading-relaxed text-zinc-700">
            {order.shipping_address.first_name} {order.shipping_address.last_name}<br />
            {order.shipping_address.address1}
            {order.shipping_address.address2 ? `, ${order.shipping_address.address2}` : ""}<br />
            {order.shipping_address.city},{" "}
            {order.shipping_address.province_code || order.shipping_address.province}{" "}
            {order.shipping_address.zip}
          </div>
        </article>
      )}
    </div>
  );
}
