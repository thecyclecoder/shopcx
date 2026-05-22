"use client";

/**
 * Subscription detail screen — every retention action lives here.
 *
 * Loads the full contract from `/api/portal?route=subscriptionDetail`
 * once on mount. From there, child cards (added in subsequent
 * commits) each own a mutation and call `refresh()` after a
 * successful change so the screen reflects new state without a hard
 * reload.
 *
 * This first cut renders the header + line items + status pills.
 * Subsequent commits add: ItemsCard with disclosures + modals
 * (swap / qty / remove), Pause / Resume / Reactivate, OrderActions,
 * Frequency, Address, Coupon, PaymentMethod, Cancel, Shipping
 * Protection, Rewards, Reviews.
 */

import { useCallback, useEffect, useState } from "react";

interface ContractLine {
  id: string;
  title?: string;
  variantTitle?: string | null;
  quantity?: number;
  sku?: string | null;
  variantId?: string;
  productId?: string;
  variantImage?: { transformedSrc?: string } | null;
  currentPrice?: { amount?: string };
  is_gift?: boolean;
}

interface Contract {
  id: string;
  shopify_contract_id?: string;
  status: string;
  nextBillingDate?: string | null;
  billingPolicy?: { interval?: string; intervalCount?: number };
  billingInterval?: string;
  billingIntervalCount?: number;
  lines?: ContractLine[];
  appliedDiscounts?: Array<{ title?: string; value?: number; valueType?: string }>;
  shippingAddress?: Record<string, string> | null;
  is_internal?: boolean | null;
  portalState?: {
    bucket?: string;
    needsAttention?: boolean;
    recoveryStatus?: string | null;
  };
  crisisBanner?: { type?: string; message?: string } | null;
}

interface Props {
  subscriptionId: string;
  workspace: { primaryColor: string };
}

export function SubscriptionDetailScreen({ subscriptionId, workspace }: Props) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // subscriptionDetail handler keys off contractId (Shopify/Appstle
      // id). Resolve via the subscriptions list and find the matching
      // row — the list endpoint already returns everything we need
      // wrapped in the transformer-friendly contract shape.
      const listRes = await fetch("/api/portal?route=subscriptions", { credentials: "same-origin" });
      if (!listRes.ok) throw new Error("Could not load subscriptions");
      const list = await listRes.json();
      const found = (list.contracts || []).find((c: { internal_id?: string; id?: string }) => {
        return c.internal_id === subscriptionId || c.id === subscriptionId;
      });
      if (!found) throw new Error("Subscription not found");
      setContract(found as Contract);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [subscriptionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-zinc-100" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />
      </div>
    );
  }
  if (error || !contract) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <p className="text-sm font-semibold text-rose-800">Couldn&apos;t load this subscription</p>
        <p className="mt-1 text-xs text-rose-700">{error || "Unknown error"}</p>
        <a href="/subscriptions" className="mt-3 inline-block text-sm font-semibold text-rose-700 underline">
          ← Back to subscriptions
        </a>
      </div>
    );
  }

  const realLines = (contract.lines || []).filter((l) => !l.is_gift);
  const totalCents = realLines.reduce((s, l) => {
    const price = parseFloat(l.currentPrice?.amount || "0");
    return s + Math.round(price * 100) * (l.quantity || 1);
  }, 0);
  const cadence = (() => {
    const interval = contract.billingPolicy?.interval || contract.billingInterval || "month";
    const count = contract.billingPolicy?.intervalCount || contract.billingIntervalCount || 1;
    return `Every ${count} ${interval.toLowerCase()}${count > 1 ? "s" : ""}`;
  })();
  const next = contract.nextBillingDate
    ? new Date(contract.nextBillingDate).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      })
    : null;
  const status = (contract.status || "").toLowerCase();

  return (
    <div className="space-y-5">
      {/* Breadcrumb back link */}
      <a
        href="/subscriptions"
        onClick={(e) => { e.preventDefault(); window.location.href = "/subscriptions"; }}
        className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        All subscriptions
      </a>

      {/* Crisis banner (informational) */}
      {contract.crisisBanner?.message && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {contract.crisisBanner.message}
        </div>
      )}

      {/* Needs-attention banner (payment failure) */}
      {contract.portalState?.needsAttention && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-800">Action needed</p>
          <p className="mt-1 text-xs text-rose-700">
            We weren&apos;t able to process your most recent payment. Update your card to keep this subscription active.
          </p>
        </div>
      )}

      {/* Header card */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="flex flex-col gap-2 border-b border-zinc-100 p-5 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {status === "paused" ? "Paused subscription" : status === "cancelled" ? "Cancelled subscription" : "Next delivery"}
              </p>
              <StatusPill status={status} primaryColor={workspace.primaryColor} />
            </div>
            <p className="mt-0.5 text-lg font-semibold text-zinc-900">
              {status === "paused" ? "Resume anytime" : status === "cancelled" ? "No upcoming charges" : next || "Date to be set"}
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
          {(contract.lines || []).map((ln, i) => {
            const priceCents = Math.round(parseFloat(ln.currentPrice?.amount || "0") * 100);
            const img = ln.variantImage?.transformedSrc;
            return (
              <li key={ln.id || i} className="flex items-center gap-4 p-4 sm:p-5">
                {img ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img} alt={ln.title || "Item"} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-zinc-900">
                    {ln.title || "Item"}
                    {ln.variantTitle && ln.variantTitle !== "Default Title" && (
                      <span className="text-zinc-500"> — {ln.variantTitle}</span>
                    )}
                    {ln.is_gift && (
                      <span className="ml-2 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                        Free gift
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-500">Qty {ln.quantity || 1}</div>
                </div>
                <div className="text-sm font-medium text-zinc-900">
                  {ln.is_gift ? <span className="text-emerald-700">Free</span> : `$${(priceCents / 100).toFixed(2)}`}
                </div>
              </li>
            );
          })}
        </ul>
      </article>

      {/* Action cards mount here in subsequent commits:
          - ItemsActionsCard (swap / qty / remove with modals)
          - PauseCard / ResumeCard / ReactivateCard
          - OrderActionsCard (order now / change date)
          - FrequencyCard
          - AddressCard
          - CouponCard
          - PaymentMethodCard
          - CancelCard
          - ShippingProtectionCard
          - RewardsCard
          - ReviewsCard
      */}
    </div>
  );
}

function StatusPill({ status, primaryColor }: { status: string; primaryColor: string }) {
  void primaryColor;
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "paused"
        ? "bg-amber-100 text-amber-800"
        : status === "cancelled"
          ? "bg-zinc-200 text-zinc-700"
          : "bg-zinc-100 text-zinc-700";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}
