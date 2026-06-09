"use client";

/**
 * Subscriptions list — read-only summary cards.
 *
 * Every retention action (skip, pause, swap, cancel-journey, etc.)
 * lives on the detail page at /subscriptions/{uuid}. The list view
 * stays focused: at a glance, what am I getting, when am I getting
 * it, what does it cost. One "Manage subscription" button per card
 * navigates to the detail page where the retention surface lives.
 *
 * Reads from our `subscriptions` table — dual-handles Appstle
 * (is_internal=false/null) and internally-managed (is_internal=true)
 * rows with no caller-visible distinction.
 */

import type { PortalSubscription } from "../page";
import { friendlyCadence } from "@/lib/portal/helpers/cadence";

interface Props {
  subscriptions: PortalSubscription[];
  workspace: { primaryColor: string };
}

export function SubscriptionsSection({ subscriptions, workspace }: Props) {
  const active = subscriptions.filter((s) => s.status === "active");
  const paused = subscriptions.filter((s) => s.status === "paused");

  if (subscriptions.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-10 text-center">
        <p className="text-base font-semibold text-zinc-700">No active subscriptions</p>
        <p className="mt-1 text-sm text-zinc-500">
          When you start a subscription it&apos;ll show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {active.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Active{active.length > 1 ? ` (${active.length})` : ""}
          </h2>
          <div className="space-y-4">
            {active.map((s) => (
              <SubCard key={s.id} sub={s} primaryColor={workspace.primaryColor} />
            ))}
          </div>
        </section>
      )}

      {paused.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            Paused{paused.length > 1 ? ` (${paused.length})` : ""}
          </h2>
          <div className="space-y-4">
            {paused.map((s) => (
              <SubCard key={s.id} sub={s} primaryColor={workspace.primaryColor} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function pillClasses(kind: string): string {
  if (kind === "free_shipping") return "bg-sky-50 text-sky-700";
  if (kind === "coupon") return "bg-amber-50 text-amber-700";
  return "bg-emerald-50 text-emerald-700"; // sns + quantity_break
}

function SubCard({ sub, primaryColor }: { sub: PortalSubscription; primaryColor: string }) {
  // Prefer the live per-delivery total from the pricing engine; fall back to a
  // naive sum only if pricing wasn't attached.
  const totalCents =
    sub.pricing?.total_cents ??
    sub.items.filter((i) => !i.is_gift).reduce((s, i) => s + (i.price_cents || 0) * i.quantity, 0);
  const pills = sub.pricing?.pills || [];
  const nextBilling = sub.next_billing_date
    ? new Date(sub.next_billing_date).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
      })
    : null;
  const cadence = friendlyCadence(sub.billing_interval, sub.billing_interval_count);

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <header className="flex flex-col gap-1 border-b border-zinc-100 p-5 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            {sub.status === "paused" ? "Paused subscription" : "Next delivery"}
          </p>
          <p className="mt-0.5 text-base font-semibold text-zinc-900">
            {sub.status === "paused"
              ? "Resume anytime"
              : nextBilling || "Date to be set"}
          </p>
        </div>
        <div className="text-left text-sm text-zinc-500 sm:text-right">
          <div>{cadence}</div>
          <div className="mt-0.5 font-medium text-zinc-700">
            ${(totalCents / 100).toFixed(2)} per delivery
          </div>
        </div>
      </header>

      {pills.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-4 py-3 sm:px-5">
          {pills.map((pill, i) => (
            <span
              key={i}
              className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${pillClasses(pill.kind)}`}
            >
              {pill.label}
            </span>
          ))}
        </div>
      )}

      <ul className="divide-y divide-zinc-100">
        {sub.items.map((it, i) => (
          <li key={i} className="flex items-center gap-4 p-4 sm:p-5">
            {it.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.image_url}
                alt={it.title}
                className="h-14 w-14 flex-shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
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
              <div className="mt-0.5 text-xs text-zinc-500">Qty {it.quantity}</div>
            </div>
            <div className="text-right text-sm font-medium text-zinc-900">
              {it.is_gift ? (
                <span className="text-emerald-700">Free</span>
              ) : (
                <>
                  {it.base_price_cents && it.base_price_cents > (it.price_cents || 0) && (
                    <span className="mr-1.5 text-xs font-normal text-zinc-400 line-through">
                      ${(it.base_price_cents / 100).toFixed(2)}
                    </span>
                  )}
                  ${((it.price_cents || 0) / 100).toFixed(2)}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex justify-end border-t border-zinc-100 bg-zinc-50 px-4 py-3 sm:px-5">
        <a
          href={`/subscriptions/${sub.id}`}
          onClick={(e) => {
            // Same-origin client-side navigation that lets middleware
            // rewrite to /portal/{slug}/subscriptions/{id} keep the URL
            // bar clean on the custom portal subdomain.
            e.preventDefault();
            window.location.href = `/subscriptions/${sub.id}`;
          }}
          className="inline-flex items-center gap-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          style={{ background: primaryColor }}
        >
          Manage subscription
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </a>
      </div>
    </article>
  );
}
