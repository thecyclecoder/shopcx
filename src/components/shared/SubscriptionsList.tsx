"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents, formatDate, formatItemName } from "./format-utils";

export interface SubscriptionItemData {
  title: string | null;
  variant_title?: string | null;
  sku?: string | null;
  quantity: number;
  price_cents: number;
  selling_plan?: string | null;
}

export interface SubscriptionData {
  id: string;
  shopify_contract_id?: string;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  items: SubscriptionItemData[];
  delivery_price_cents?: number;
  applied_discounts?: { id: string; type: string; title: string; value: number; valueType: string }[];
  created_at?: string;
  updated_at?: string;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  paused: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

const FALLBACK_BADGE = "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";

interface SubscriptionsListProps {
  subscriptions: SubscriptionData[];
  /** "full" = standalone section (customer detail), "compact" = collapsible sidebar card (ticket detail) */
  variant?: "full" | "compact";
  /** Show item prices (used in full variant) */
  showPrices?: boolean;
  /** Max items to show per subscription before "+N more" (compact only, default 3) */
  maxItems?: number;
}

/**
 * Shared subscriptions list used on customer detail and ticket detail pages.
 */
export default function SubscriptionsList({
  subscriptions,
  variant = "full",
  showPrices = true,
  maxItems = 3,
}: SubscriptionsListProps) {
  const router = useRouter();

  if (subscriptions.length === 0) return null;

  if (variant === "compact") {
    return (
      <div className="space-y-2">
        {subscriptions.map((sub) => (
          <div key={sub.id} className="rounded border border-zinc-200 bg-zinc-50 px-2.5 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800">
            <div className="flex items-center justify-between">
              <button
                onClick={() => router.push(`/dashboard/subscriptions/${sub.id}`)}
                className="flex items-center gap-1.5"
              >
                <span className={`rounded px-1.5 py-0.5 text-sm font-medium ${STATUS_BADGE[sub.status] || FALLBACK_BADGE}`}>
                  {sub.status}
                </span>
                <svg className="h-3 w-3 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" /></svg>
              </button>
              {sub.billing_interval && (
                <span className="text-sm text-zinc-400">
                  {sub.billing_interval_count}/{sub.billing_interval}
                </span>
              )}
            </div>
            {sub.items?.length > 0 && (
              <div className="mt-1 space-y-0.5">
                {sub.items.slice(0, maxItems).map((item, idx) => (
                  <p key={idx} className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                    {item.quantity}x {formatItemName(item)}
                  </p>
                ))}
                {sub.items.length > maxItems && (
                  <p className="text-sm text-zinc-400">+{sub.items.length - maxItems} more</p>
                )}
              </div>
            )}
            {sub.next_billing_date && (
              <p className="mt-1 text-sm text-zinc-400">Next: {formatDate(sub.next_billing_date)}</p>
            )}
          </div>
        ))}
      </div>
    );
  }

  // Full variant (customer detail page)
  return (
    <div className="space-y-2">
      {subscriptions.map((sub) => (
        <div
          key={sub.id}
          onClick={() => router.push(`/dashboard/subscriptions/${sub.id}`)}
          className={`cursor-pointer rounded-lg border p-3 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700 ${
            sub.last_payment_status === "failed"
              ? "border-amber-200 bg-amber-50/30 dark:border-amber-800/50 dark:bg-amber-950/20"
              : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-sm font-medium ${STATUS_BADGE[sub.status] || FALLBACK_BADGE}`}>
                {sub.status}
              </span>
              {sub.billing_interval && sub.billing_interval_count && (
                <span className="text-sm text-zinc-500">
                  Every {sub.billing_interval_count} {sub.billing_interval}{sub.billing_interval_count > 1 ? "s" : ""}
                </span>
              )}
              {sub.last_payment_status === "failed" && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">In Recovery</span>
              )}
            </div>
            {sub.last_payment_status && (
              <span className={`text-sm ${
                sub.last_payment_status === "succeeded" ? "text-emerald-500"
                : sub.last_payment_status === "failed" ? "text-red-500"
                : "text-zinc-400"
              }`}>
                {sub.last_payment_status}
              </span>
            )}
          </div>
          {sub.items?.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {sub.items.map((item, idx) => (
                <div key={idx} className="flex justify-between text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">{item.quantity}x {formatItemName(item)}</span>
                  {showPrices && (
                    <span className="text-zinc-400">{formatCents(item.price_cents * item.quantity)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {sub.applied_discounts && sub.applied_discounts.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {sub.applied_discounts.map((d, i) => (
                <span key={i} className="inline-flex items-center rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400">
                  {d.title} {d.value}{d.valueType === "PERCENTAGE" ? "%" : ""} off
                </span>
              ))}
            </div>
          )}
          {sub.next_billing_date && (
            <p className="mt-1.5 text-sm text-zinc-400">
              Next billing: {formatDate(sub.next_billing_date)}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
