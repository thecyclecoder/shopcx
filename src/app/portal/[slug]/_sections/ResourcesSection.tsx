"use client";

/**
 * Resources section — helpful guides based on the customer's
 * active subscriptions.
 *
 * V1 placeholder. The data model for resources doesn't exist yet —
 * future state is a resources table keyed by product/variant that
 * we can target articles to. For now we show the products on the
 * customer's active subs with a "Coming soon" surface, so the
 * sidebar tab has something to render.
 */

import type { PortalSubscription } from "../page";

interface Props {
  subscriptions: PortalSubscription[];
}

export function ResourcesSection({ subscriptions }: Props) {
  // Deduped product titles across active subs.
  const products = Array.from(
    new Set(
      subscriptions
        .filter((s) => s.status === "active")
        .flatMap((s) => s.items.filter((i) => !i.is_gift).map((i) => i.title)),
    ),
  );

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-900">Get the most from your subscription</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Recipes, mixing tips, and best-practice guides curated for the products you&apos;re subscribed to.
        </p>
      </div>

      {products.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center">
          <p className="text-sm text-zinc-600">
            Subscribe to a product to unlock personalized resources.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {products.map((p) => (
            <div key={p} className="rounded-2xl border border-zinc-200 bg-white p-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                For your
              </div>
              <h3 className="mt-1 text-base font-semibold text-zinc-900">{p}</h3>
              <p className="mt-2 text-sm text-zinc-500">
                Guides &amp; recipes coming soon. We&apos;ll let you know the moment they&apos;re live.
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
