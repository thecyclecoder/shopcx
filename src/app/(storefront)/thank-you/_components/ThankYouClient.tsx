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
  savings_cents?: number;
  subtotal_cents?: number;
  discount_cents?: number;
  discount_code?: string | null;
  shipping_protection_cents?: number;
  tax_cents?: number;
}

interface ReviewProps {
  reviewer_name: string | null;
  rating: number;
  body: string | null;
}

interface Workspace {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string;
  meta_pixel_id?: string | null;
}

export function ThankYouClient({ order, workspace, review }: { order: OrderProps; workspace: Workspace; review?: ReviewProps | null }) {
  useEffect(() => {
    // The canonical order_placed event (→ Meta Purchase, with the server
    // CAPI backstop) fires from the checkout page immediately after the
    // confirmed charge — the most reliable capture point, since the order
    // exists even if this redirect fails to load. We DON'T re-fire it here
    // (the old `checkout_completed` was dropped by the pixel allowlist and
    // would double-count Purchase if revived). initPixel still fires Meta
    // PageView on the confirmation page.
    initPixel({ workspaceId: workspace.id, customerId: null, metaPixelId: workspace.meta_pixel_id || null });
    void track; // retained import; no thank-you-side funnel event
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
          <img src={workspace.logo_url} alt={workspace.name} className="h-16 w-auto max-w-[260px] sm:h-20" />
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
          <div className="mt-4 space-y-1.5 border-t border-zinc-200 pt-3 text-sm">
            {order.subtotal_cents != null && (
              <div className="flex justify-between">
                <span className="text-zinc-600">Subtotal</span>
                <span className="text-zinc-800">${(order.subtotal_cents / 100).toFixed(2)}</span>
              </div>
            )}
            {order.discount_cents ? (
              <div className="flex justify-between">
                <span className="text-emerald-700">Discount{order.discount_code ? ` (${order.discount_code})` : ""}</span>
                <span className="font-semibold text-emerald-700">−${(order.discount_cents / 100).toFixed(2)}</span>
              </div>
            ) : null}
            {order.shipping_protection_cents ? (
              <div className="flex justify-between">
                <span className="text-zinc-600">Shipping Protection</span>
                <span className="text-zinc-800">${(order.shipping_protection_cents / 100).toFixed(2)}</span>
              </div>
            ) : null}
            {order.tax_cents ? (
              <div className="flex justify-between">
                <span className="text-zinc-600">Sales Tax</span>
                <span className="text-zinc-800">${(order.tax_cents / 100).toFixed(2)}</span>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between border-t border-zinc-100 pt-1.5">
              <span className="font-semibold text-zinc-800">Total</span>
              <span className="text-lg font-bold text-zinc-900">${(order.total_cents / 100).toFixed(2)}</span>
            </div>
          </div>
          {order.savings_cents && order.savings_cents > 0 ? (
            <div className="mt-3 text-right">
              <span className="inline-block rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
                🎉 You saved ${(order.savings_cents / 100).toFixed(2)} on this order
              </span>
            </div>
          ) : null}
        </section>
      )}

      {review && review.body && (
        <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">What customers are saying</p>
          <div className="text-amber-500" aria-hidden>{"★".repeat(Math.round(review.rating || 5))}</div>
          <p className="mt-1 text-sm leading-relaxed text-zinc-700">“{review.body}”</p>
          {review.reviewer_name && <p className="mt-2 text-xs font-semibold text-zinc-500">— {review.reviewer_name}</p>}
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

      {/* Portal CTA — uses the sx_session cookie set during OTP-at-
          checkout, so an authenticated buyer goes straight to the
          portal. Anyone without a session can still reach /account
          and enter their email there (OTP first, magic-link fallback). */}
      <section className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-5 text-center shadow-sm">
        <p className="text-sm text-zinc-600">
          Manage your subscriptions, track orders, or update your shipping address anytime.
        </p>
        <a
          href="/account"
          className="rounded-full px-6 py-2.5 text-sm font-semibold text-white shadow-sm"
          style={{ backgroundColor: workspace.primary_color }}
        >
          View my account →
        </a>
      </section>

      <p className="mt-8 text-center text-sm text-zinc-500">
        Questions about your order? Just reply to your confirmation email.
      </p>
    </div>
  );
}
