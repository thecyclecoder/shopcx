"use client";

/**
 * Thank-you client island. Fires the final funnel events on mount
 * (checkout_completed + a richer order_placed with the resolved order
 * id) and renders a confirmation summary. Post-purchase upsell flow
 * will hook in here later — for now the page is a clean dead-end so
 * the customer always has a clear "we got it" moment.
 */

import { useEffect } from "react";
import { initPixel, track } from "@/lib/storefront-pixel";

interface OrderLineItem {
  title?: string;
  variant_title?: string;
  quantity?: number;
  image_url?: string | null;
  line_total_cents?: number;
}

interface OrderProps {
  id: string;
  order_number: string | null;
  email: string | null;
  total_cents: number;
  currency: string;
  line_items: Array<Record<string, unknown>>;
  shipping_address: Record<string, string> | null;
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
}

export function ThankYouClient({ order, workspace }: { order: OrderProps; workspace: Workspace }) {
  useEffect(() => {
    initPixel({ workspaceId: workspace.id, customerId: null });
    track("checkout_completed", {
      order_id: order.id,
      order_number: order.order_number,
      total_cents: order.total_cents,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = order.line_items as OrderLineItem[];
  const ship = order.shipping_address || {};

  const themeStyle = { "--storefront-primary": workspace.primary_color } as React.CSSProperties;

  return (
    <div style={themeStyle} className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-8 flex items-center justify-center">
        {workspace.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={workspace.logo_url} alt={workspace.name} className="h-10" />
        ) : (
          <span className="text-xl font-semibold">{workspace.name}</span>
        )}
      </header>

      <section
        className="rounded-3xl border border-emerald-100 bg-gradient-to-br from-emerald-50 to-white p-8 text-center shadow-sm"
      >
        <div
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full"
          style={{ backgroundColor: workspace.primary_color }}
        >
          <svg className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="mt-5 text-3xl font-bold text-zinc-900 sm:text-4xl">Thanks for your order!</h1>
        <p className="mt-2 text-base text-zinc-600">
          We sent a confirmation to <span className="font-medium text-zinc-900">{order.email || "your email"}</span>.
        </p>
        {order.order_number && (
          <p className="mt-1 text-sm font-mono text-zinc-500">Order {order.order_number}</p>
        )}
      </section>

      {items.length > 0 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">What you ordered</p>
          <ul className="mt-3 space-y-3">
            {items.map((l, i) => (
              <li key={i} className="flex items-center gap-3">
                {l.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.image_url} alt={l.title || ""} className="h-12 w-12 flex-shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-zinc-100" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-zinc-900">
                    {l.title}
                    {l.variant_title && l.variant_title !== "Default Title" && (
                      <span className="ml-1 text-zinc-500">— {l.variant_title}</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">Qty {l.quantity || 1}</div>
                </div>
                <div className="text-sm font-semibold text-zinc-900">
                  ${((l.line_total_cents || 0) / 100).toFixed(2)}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-baseline justify-between border-t border-zinc-200 pt-3">
            <span className="text-sm text-zinc-700">Total</span>
            <span className="text-lg font-bold text-zinc-900">${(order.total_cents / 100).toFixed(2)}</span>
          </div>
        </section>
      )}

      {ship.address1 && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Shipping to</p>
          <p className="mt-2 text-sm text-zinc-700">
            {[ship.first_name, ship.last_name].filter(Boolean).join(" ")}
            <br />
            {ship.address1}
            {ship.address2 ? `, ${ship.address2}` : ""}
            <br />
            {[ship.city, ship.province_code, ship.zip].filter(Boolean).join(", ")}
          </p>
        </section>
      )}

      <p className="mt-8 text-center text-sm text-zinc-500">
        Questions about your order? Just reply to your confirmation email.
      </p>
    </div>
  );
}
