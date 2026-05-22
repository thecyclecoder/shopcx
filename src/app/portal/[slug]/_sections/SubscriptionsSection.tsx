"use client";

/**
 * Subscriptions section — full mutations.
 *
 * Reads from our `subscriptions` table, which already holds BOTH
 * Appstle-managed (is_internal=false/null) and internally-managed
 * (is_internal=true) subscription rows. Customer sees no distinction
 * between the two — that's the whole point.
 *
 * Mutations route through /api/portal?route=X which (a) is already
 * magic-link-cookie auth aware and (b) dispatches to handlers that
 * route by is_internal flag automatically. So Pause on an Appstle
 * sub hits Appstle; Pause on an internal sub mutates our row.
 *
 * Actions wired:
 *   - Pause / Resume (toggle based on status)
 *   - Skip next (advance next_billing_date by one interval)
 *   - Cancel (routes to cancel journey — retention flow)
 *
 * Save-for-v2: change frequency picker, change-date picker UI,
 * swap variant, remove item.
 */

import { useState } from "react";
import type { PortalSubscription } from "../page";

interface Props {
  subscriptions: PortalSubscription[];
  workspace: { primaryColor: string };
}

export function SubscriptionsSection({ subscriptions: initialSubs, workspace }: Props) {
  const [subs, setSubs] = useState(initialSubs);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const active = subs.filter((s) => s.status === "active");
  const paused = subs.filter((s) => s.status === "paused");

  // Refresh the list from the server after a mutation. Cheap — we
  // own the data and the page is already authed.
  async function refresh() {
    try {
      const r = await fetch("/api/portal?route=subscriptions", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      const contracts = (data?.contracts || []) as Array<Record<string, unknown>>;
      // Map portal API shape → our PortalSubscription shape. Portal
      // API returns Shopify-style contract objects; massage them so
      // the existing card renderer works.
      const mapped: PortalSubscription[] = contracts.map((c) => ({
        id: String(c.id || ""),
        shopify_contract_id: String((c.id as string)?.split("/").pop() || c.id || ""),
        status: String((c.status as string) || "").toLowerCase(),
        items: Array.isArray(c.lines)
          ? (c.lines as Array<Record<string, unknown>>).map((ln) => ({
              title: String(ln.title || ""),
              variant_title: (ln.variantTitle as string | null) || null,
              quantity: Number(ln.quantity) || 1,
              price_cents: ln.currentPrice ? Math.round(Number((ln.currentPrice as { amount: string }).amount || 0) * 100) : 0,
              image_url: (ln.variantImage as { transformedSrc?: string } | null)?.transformedSrc || null,
              sku: (ln.sku as string | null) || null,
              is_gift: false,
            }))
          : [],
        billing_interval: String(c.billingInterval || "month"),
        billing_interval_count: Number(c.billingIntervalCount) || 1,
        next_billing_date: (c.nextBillingDate as string | null) || null,
        applied_discounts: null,
        is_internal: (c.is_internal as boolean) ?? null,
        delivery_price_cents: null,
      }));
      setSubs(mapped);
    } catch { /* ignore */ }
  }

  if (subs.length === 0) {
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
              <SubCard
                key={s.id}
                sub={s}
                primaryColor={workspace.primaryColor}
                onMutate={refresh}
                onToast={setToast}
              />
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
              <SubCard
                key={s.id}
                sub={s}
                primaryColor={workspace.primaryColor}
                onMutate={refresh}
                onToast={setToast}
              />
            ))}
          </div>
        </section>
      )}

      {/* Toast — fixed bottom-center, dismisses after 4s */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-lg ${toast.kind === "ok" ? "bg-emerald-600" : "bg-rose-600"}`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function SubCard({
  sub,
  primaryColor,
  onMutate,
  onToast,
}: {
  sub: PortalSubscription;
  primaryColor: string;
  onMutate: () => Promise<void> | void;
  onToast: (t: { kind: "ok" | "err"; text: string } | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Wait 4s, then auto-clear the toast so it doesn't linger forever.
  const flash = (kind: "ok" | "err", text: string) => {
    onToast({ kind, text });
    setTimeout(() => onToast(null), 4000);
  };

  async function call(route: string, payload: Record<string, unknown>, opts: { busyKey: string; ok: string; err?: string }) {
    if (busy) return;
    setBusy(opts.busyKey);
    try {
      const res = await fetch(`/api/portal?route=${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        flash("err", opts.err || data?.message || data?.error || "Something went wrong");
        return;
      }
      flash("ok", opts.ok);
      await onMutate();
    } catch {
      flash("err", opts.err || "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function pauseSub() {
    await call("pause", { contractId: sub.shopify_contract_id }, { busyKey: "pause", ok: "Subscription paused" });
  }
  async function resumeSub() {
    await call("resume", { contractId: sub.shopify_contract_id }, { busyKey: "resume", ok: "Subscription resumed" });
  }
  async function skipNext() {
    // Advance next_billing_date by one interval. Computed client-
    // side then sent to the portal; the changeDate handler also
    // validates safety bounds (min lock days etc) on the server.
    if (!sub.next_billing_date) {
      flash("err", "No next billing date on this subscription");
      return;
    }
    const next = new Date(sub.next_billing_date);
    if (sub.billing_interval === "month") next.setMonth(next.getMonth() + sub.billing_interval_count);
    else if (sub.billing_interval === "week") next.setDate(next.getDate() + 7 * sub.billing_interval_count);
    else next.setDate(next.getDate() + sub.billing_interval_count);
    const iso = next.toISOString().slice(0, 10);
    await call("changeDate", { contractId: sub.shopify_contract_id, nextBillingDate: iso }, { busyKey: "skip", ok: `Next delivery moved to ${next.toLocaleDateString("en-US", { month: "long", day: "numeric" })}` });
  }
  async function startCancel() {
    // Routes to the cancel journey (retention flow) rather than a
    // direct cancel. The journey handler returns a journeyUrl to
    // navigate the customer to.
    if (busy) return;
    setBusy("cancel");
    try {
      const res = await fetch(`/api/portal?route=cancelJourney`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ contractId: sub.shopify_contract_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.journeyUrl) {
        window.location.href = data.journeyUrl as string;
        return;
      }
      if (data?.token) {
        window.location.href = `/journey/${data.token}`;
        return;
      }
      flash("err", data?.message || data?.error || "Could not start cancellation");
    } catch {
      flash("err", "Network error");
    } finally {
      setBusy(null);
    }
  }
  void primaryColor; // reserved for active-state pill (not currently used in this card)
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

      {/* Actions footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 bg-zinc-50 px-4 py-3 sm:px-5">
        {sub.status === "active" ? (
          <>
            <ActionBtn busy={busy === "skip"} onClick={skipNext}>Skip next delivery</ActionBtn>
            <ActionBtn busy={busy === "pause"} onClick={pauseSub}>Pause</ActionBtn>
            <ActionBtn busy={busy === "cancel"} onClick={startCancel} variant="ghost">Cancel</ActionBtn>
          </>
        ) : sub.status === "paused" ? (
          <ActionBtn busy={busy === "resume"} onClick={resumeSub} variant="primary">Resume subscription</ActionBtn>
        ) : null}
      </div>
    </article>
  );
}

function ActionBtn({
  busy,
  variant = "default",
  onClick,
  children,
}: {
  busy?: boolean;
  variant?: "default" | "primary" | "ghost";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const base = "rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50";
  const styles = {
    default: "border border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:text-zinc-900",
    primary: "border border-transparent bg-zinc-900 text-white hover:bg-zinc-800",
    ghost: "border border-transparent bg-transparent text-zinc-500 hover:text-rose-700",
  }[variant];
  return (
    <button type="button" disabled={busy} onClick={onClick} className={`${base} ${styles}`}>
      {busy ? "Working…" : children}
    </button>
  );
}
