"use client";

/**
 * Subscriptions section — Phase 1 read-only view.
 *
 * Reads from our `subscriptions` table, which already holds BOTH
 * Appstle-managed (is_internal=false/null) and internally-managed
 * (is_internal=true) subscription rows. Customer sees no distinction
 * between the two — that's the whole point.
 *
 * Actions (pause / resume / skip / swap / cancel) come in Phase 2
 * (#167) — they'll wire to the existing helpers in src/lib/appstle.ts
 * + src/lib/internal-subscription.ts that already route by
 * is_internal correctly.
 */

import type { PortalSubscription } from "../page";

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

function SubCard({ sub, primaryColor }: { sub: PortalSubscription; primaryColor: string }) {
  void primaryColor; // reserved for the action buttons (Phase 2)
  const realItems = sub.items.filter((i) => !i.is_gift);
  const totalCents = realItems.reduce((s, i) => s + (i.price_cents || 0) * i.quantity, 0);
  const nextBilling = sub.next_billing_date
    ? new Date(sub.next_billing_date).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      })
    : null;
  const cadence = `Every ${sub.billing_interval_count} ${sub.billing_interval}${sub.billing_interval_count > 1 ? "s" : ""}`;

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
            <div className="text-sm font-medium text-zinc-900">
              {it.is_gift ? (
                <span className="text-emerald-700">Free</span>
              ) : (
                `$${((it.price_cents || 0) / 100).toFixed(2)}`
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Actions placeholder — Phase 2 fills this in */}
      <div className="border-t border-zinc-100 bg-zinc-50 px-5 py-3 text-xs text-zinc-500">
        Edit, pause, swap or cancel coming next.
      </div>
    </article>
  );
}
