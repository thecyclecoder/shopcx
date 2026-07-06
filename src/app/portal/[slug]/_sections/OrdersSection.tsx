"use client";

/**
 * Orders section — order history list.
 *
 * Each row links into the order detail page (`/orders/{uuid}` on the
 * portal subdomain — middleware rewrites to /portal/{slug}/orders/{uuid}
 * → the Phase 1 route). No inline expand/collapse: line items, tracking,
 * and shipping address all live on the detail page. Keeps the honest
 * three-state delivery badge (+ optional financial tag) on each row so
 * the customer can scan status at a glance.
 */

import type { PortalOrder } from "../page";
import { deliveryStatusTag, financialTag, type OrderStatusTag } from "./order-status";

interface Props {
  orders: PortalOrder[];
  primaryColor: string;
}

/** Tone → Tailwind. Kept in the renderer so the pure classifier stays free of styling. */
const TONE_CLASS: Record<OrderStatusTag["tone"], string> = {
  emerald: "bg-emerald-50 text-emerald-700",
  sky: "bg-sky-50 text-sky-700",
  amber: "bg-amber-50 text-amber-800",
  zinc: "bg-zinc-100 text-zinc-600",
};

function fmtCents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/**
 * Row-status: the honest three-state delivery tag + an optional financial tag
 * (Cancelled / Refunded). Both may render together — the delivery lane and the
 * financial lane carry different information, so a Refunded order still shows
 * where the box got to. See [[./order-status.ts]] for the classifier.
 */
function statusTags(o: PortalOrder): { delivery: OrderStatusTag; financial: OrderStatusTag | null } {
  return {
    delivery: deliveryStatusTag(o, Date.now()),
    financial: financialTag(o),
  };
}

export function OrdersSection({ orders }: Props) {
  if (orders.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
        <p className="text-base font-semibold text-zinc-700">No orders yet</p>
        <p className="mt-1 text-sm text-zinc-500">When you place an order it&apos;ll show up here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {orders.map((o) => {
        const { delivery, financial } = statusTags(o);
        const realItems = o.line_items.filter((l) => !l.is_gift);
        const firstItem = realItems[0];
        return (
          <article key={o.id} className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
            <a
              href={`/orders/${o.id}`}
              onClick={(e) => { e.preventDefault(); window.location.href = `/orders/${o.id}`; }}
              className="flex w-full items-center gap-4 p-4 text-left transition hover:bg-zinc-50 sm:p-5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-base font-semibold text-zinc-900">{o.order_number}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[delivery.tone]}`}>
                    {delivery.label}
                  </span>
                  {financial && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[financial.tone]}`}>
                      {financial.label}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-zinc-500">
                  {new Date(o.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  {firstItem && ` · ${firstItem.title}${realItems.length > 1 ? ` + ${realItems.length - 1} more` : ""}`}
                </p>
              </div>
              <div className="text-right">
                <div className="text-base font-semibold text-zinc-900">{fmtCents(o.total_cents)}</div>
                <div className="mt-0.5 text-xs text-zinc-400">Details →</div>
              </div>
            </a>
          </article>
        );
      })}
    </div>
  );
}
