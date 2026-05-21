"use client";

/**
 * Orders section — full history with tracking + reorder.
 *
 * The page server-side-loads up to 50 recent orders (across linked
 * accounts) so the list renders without an extra fetch. Each row
 * expands inline to show line items + tracking. "Reorder these items"
 * POSTs to /api/cart with the line items and routes to /customize so
 * the customer goes through the standard cart flow (gifts, upsells).
 */

import { useState } from "react";
import type { PortalOrder } from "../page";

interface Props {
  orders: PortalOrder[];
  primaryColor: string;
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

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function statusLabel(o: PortalOrder): { label: string; tone: "emerald" | "amber" | "zinc" } {
  if (o.amplifier_status === "Shipped" || o.amplifier_tracking_number) return { label: "Shipped", tone: "emerald" };
  if (o.amplifier_status === "Cancelled") return { label: "Cancelled", tone: "zinc" };
  if (o.financial_status === "refunded" || o.financial_status === "partially_refunded") return { label: "Refunded", tone: "amber" };
  if (o.amplifier_status) return { label: o.amplifier_status, tone: "amber" };
  return { label: "Processing", tone: "amber" };
}

export function OrdersSection({ orders, primaryColor }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [reordering, setReordering] = useState<string | null>(null);

  if (orders.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
        <p className="text-base font-semibold text-zinc-700">No orders yet</p>
        <p className="mt-1 text-sm text-zinc-500">When you place an order it&apos;ll show up here.</p>
      </div>
    );
  }

  async function reorder(o: PortalOrder) {
    if (reordering) return;
    setReordering(o.id);
    try {
      // Build a fresh cart_draft with the order's chargeable line
      // items (skip gifts; cart auto-injects qualifying gifts on
      // its own). All items default to one-time mode — customer
      // picks subscribe/onetime in /customize.
      const lines = o.line_items
        .filter((l) => !l.is_gift && l.variant_id)
        .map((l) => ({
          variant_id: l.variant_id!,
          quantity: l.quantity,
        }));
      if (lines.length === 0) {
        setReordering(null);
        return;
      }
      // We need workspace_id — read it from any cookie? No, use a
      // small POST that lets /api/cart figure it out from session.
      // /api/cart actually requires workspace_id. Hack: fetch the
      // page metadata via the portal. Simpler: include the
      // workspace via a query the portal exposes. For v1, hit the
      // bootstrap endpoint to discover workspace_id.
      const boot = await fetch("/api/portal?route=bootstrap", { credentials: "same-origin" });
      const bootData = await boot.json().catch(() => ({}));
      const workspaceId = bootData?.config?.workspace_id || bootData?.workspace_id;
      if (!workspaceId) {
        setReordering(null);
        return;
      }
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspace_id: workspaceId,
          line_items: lines,
          mode: "onetime",
        }),
      });
      const data = await res.json().catch(() => ({}));
      const token = data?.cart?.token;
      if (token) {
        window.location.href = `/customize?token=${encodeURIComponent(token)}`;
        return;
      }
    } catch { /* ignore */ }
    setReordering(null);
  }

  return (
    <div className="space-y-3">
      {orders.map((o) => {
        const isOpen = openId === o.id;
        const tone = statusLabel(o);
        const toneClass = tone.tone === "emerald"
          ? "bg-emerald-50 text-emerald-700"
          : tone.tone === "amber"
            ? "bg-amber-50 text-amber-800"
            : "bg-zinc-100 text-zinc-600";
        const realItems = o.line_items.filter((l) => !l.is_gift);
        const firstItem = realItems[0];
        return (
          <article key={o.id} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : o.id)}
              className="flex w-full items-center gap-4 p-4 text-left transition hover:bg-zinc-50 sm:p-5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-base font-semibold text-zinc-900">{o.order_number}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneClass}`}>
                    {tone.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-zinc-500">
                  {new Date(o.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  {firstItem && ` · ${firstItem.title}${realItems.length > 1 ? ` + ${realItems.length - 1} more` : ""}`}
                </p>
              </div>
              <div className="text-right">
                <div className="text-base font-semibold text-zinc-900">{fmtCents(o.total_cents)}</div>
                <div className="mt-0.5 text-xs text-zinc-400">{isOpen ? "Collapse" : "Details"}</div>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-zinc-100 px-4 py-4 sm:px-5">
                <ul className="divide-y divide-zinc-100">
                  {o.line_items.map((it, i) => (
                    <li key={i} className="flex items-center gap-3 py-2.5">
                      {it.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={it.image_url} alt={it.title} className="h-12 w-12 flex-shrink-0 rounded-md object-cover" />
                      ) : (
                        <div className="h-12 w-12 flex-shrink-0 rounded-md bg-zinc-100" />
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
                      <div className="text-sm text-zinc-700">
                        {it.is_gift
                          ? "Free"
                          : fmtCents(it.line_total_cents ?? (it.unit_price_cents || 0) * it.quantity)}
                      </div>
                    </li>
                  ))}
                </ul>

                {o.amplifier_tracking_number && (
                  <div className="mt-4 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
                    <div className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
                      Tracking{o.amplifier_carrier ? ` (${o.amplifier_carrier})` : ""}
                    </div>
                    <div className="mt-1 font-mono">{o.amplifier_tracking_number}</div>
                    {trackingUrl(o.amplifier_carrier, o.amplifier_tracking_number) && (
                      <a
                        href={trackingUrl(o.amplifier_carrier, o.amplifier_tracking_number)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-block text-sm font-semibold underline-offset-2 hover:underline"
                      >
                        Track package →
                      </a>
                    )}
                  </div>
                )}

                {o.shipping_address && (
                  <div className="mt-4 text-sm text-zinc-700">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                      Shipped to
                    </div>
                    <div className="leading-relaxed">
                      {o.shipping_address.first_name} {o.shipping_address.last_name}<br />
                      {o.shipping_address.address1}{o.shipping_address.address2 ? `, ${o.shipping_address.address2}` : ""}<br />
                      {o.shipping_address.city}, {o.shipping_address.province_code} {o.shipping_address.zip}
                    </div>
                  </div>
                )}

                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => reorder(o)}
                    disabled={reordering === o.id}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:opacity-50"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {reordering === o.id ? "Loading…" : "Reorder these items"}
                  </button>
                </div>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
