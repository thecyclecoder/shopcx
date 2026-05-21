"use client";

/**
 * Home / Overview — the portal landing page.
 *
 * Shows at-a-glance status: next delivery, latest shipped order,
 * and a few directional CTAs into other sections. Designed as a
 * surface we can extend with marketing content (new product
 * launches, feature announcements) later — for now it's the
 * "your account at a glance" view.
 */

import type { PortalSubscription, PortalOrder } from "../page";

interface Props {
  firstName: string;
  subscriptions: PortalSubscription[];
  orders: PortalOrder[];
  primaryColor: string;
  onNavigate: (section: "home" | "subscriptions" | "orders" | "payment_methods" | "support" | "account" | "resources") => void;
}

export function HomeSection({ firstName, subscriptions, orders, primaryColor, onNavigate }: Props) {
  const activeSubs = subscriptions.filter((s) => s.status === "active");
  const nextSub = activeSubs
    .filter((s) => s.next_billing_date)
    .sort((a, b) => new Date(a.next_billing_date!).getTime() - new Date(b.next_billing_date!).getTime())[0];

  const latestOrder = orders[0];
  const shipped = orders.find((o) => o.amplifier_shipped_at);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <p className="text-sm text-zinc-500">Welcome back</p>
        <h2 className="mt-1 text-2xl font-bold text-zinc-900">
          {firstName ? `Hi ${firstName}` : "Welcome"}
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          Manage your subscriptions, track orders, and update your account here.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Next delivery */}
        {nextSub ? (
          <button
            type="button"
            onClick={() => onNavigate("subscriptions")}
            className="rounded-2xl border border-zinc-200 bg-white p-5 text-left transition hover:border-zinc-300"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Next delivery</p>
            <p className="mt-2 text-lg font-semibold text-zinc-900">
              {new Date(nextSub.next_billing_date!).toLocaleDateString("en-US", {
                weekday: "long", month: "long", day: "numeric",
              })}
            </p>
            <p className="mt-1 text-sm text-zinc-500 truncate">
              {nextSub.items.filter((i) => !i.is_gift).map((i) => i.title).slice(0, 2).join(", ")}
              {nextSub.items.filter((i) => !i.is_gift).length > 2 ? "…" : ""}
            </p>
            <p className="mt-3 text-sm font-semibold" style={{ color: primaryColor }}>
              Manage subscription →
            </p>
          </button>
        ) : (
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Subscriptions</p>
            <p className="mt-2 text-sm text-zinc-500">No active subscriptions.</p>
          </div>
        )}

        {/* Latest order */}
        {latestOrder ? (
          <button
            type="button"
            onClick={() => onNavigate("orders")}
            className="rounded-2xl border border-zinc-200 bg-white p-5 text-left transition hover:border-zinc-300"
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              {shipped ? "Latest shipment" : "Latest order"}
            </p>
            <p className="mt-2 text-lg font-semibold text-zinc-900">
              {latestOrder.order_number}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              {new Date(latestOrder.created_at).toLocaleDateString("en-US", {
                month: "long", day: "numeric", year: "numeric",
              })}
            </p>
            {latestOrder.amplifier_tracking_number && (
              <p className="mt-1 text-xs text-emerald-700">
                Tracking: {latestOrder.amplifier_tracking_number}
              </p>
            )}
            <p className="mt-3 text-sm font-semibold" style={{ color: primaryColor }}>
              View all orders →
            </p>
          </button>
        ) : (
          <div className="rounded-2xl border border-zinc-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Orders</p>
            <p className="mt-2 text-sm text-zinc-500">No recent orders.</p>
          </div>
        )}
      </div>

      {/* Helpful resources nudge */}
      <button
        type="button"
        onClick={() => onNavigate("resources")}
        className="block w-full rounded-2xl border border-zinc-200 bg-white p-5 text-left transition hover:border-zinc-300"
      >
        <p className="text-sm font-semibold text-zinc-900">Get the most from your products</p>
        <p className="mt-1 text-sm text-zinc-500">
          Recipes, mixing tips, and best-practice guides tailored to what&apos;s in your subscription.
        </p>
        <p className="mt-3 text-sm font-semibold" style={{ color: primaryColor }}>
          Explore resources →
        </p>
      </button>
    </div>
  );
}
