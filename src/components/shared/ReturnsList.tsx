"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { formatCents, formatDate } from "./format-utils";

export interface ReturnItem {
  id: string;
  order_number: string;
  status: string;
  resolution_type: string;
  net_refund_cents: number;
  tracking_number?: string | null;
  created_at: string;
}

const RETURN_STATUS_BADGE: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  in_transit: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  refunded: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  cancelled: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  restocked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
};

const FALLBACK_BADGE = "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";

const RESOLUTION_LABELS: Record<string, string> = {
  store_credit_return: "Store Credit",
  refund_return: "Refund",
  store_credit_no_return: "Store Credit (no return)",
  refund_no_return: "Refund (no return)",
};

function getResolutionLabel(type: string): string {
  return RESOLUTION_LABELS[type] || type;
}

interface ReturnsListProps {
  returns: ReturnItem[];
  /** "full" = standalone section with border (customer detail), "compact" = collapsible sidebar (ticket detail), "bare" = no border wrapper (when inside an existing card) */
  variant?: "full" | "compact" | "bare";
  /** Show date column on the right (used in full variant) */
  showDate?: boolean;
}

/**
 * Shared returns list used on customer detail, subscription detail, and ticket detail pages.
 */
export default function ReturnsList({ returns, variant = "full", showDate = false }: ReturnsListProps) {
  const router = useRouter();

  if (returns.length === 0) return null;

  return (
    <div className={
      variant === "full" ? "divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900"
      : variant === "bare" ? "divide-y divide-zinc-100 dark:divide-zinc-800"
      : "divide-y divide-zinc-100 dark:divide-zinc-800"
    }>
      {returns.map((r) => {
        const badge = RETURN_STATUS_BADGE[r.status] || FALLBACK_BADGE;
        const resLabel = getResolutionLabel(r.resolution_type);

        if (variant === "compact") {
          return (
            <a
              key={r.id}
              href={`/dashboard/returns/${r.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded px-1 py-1.5 text-sm transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
            >
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge}`}>{r.status}</span>
                <span className="text-zinc-700 dark:text-zinc-300">{r.order_number}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400">{resLabel}</span>
                <span className="tabular-nums text-zinc-500">{formatCents(r.net_refund_cents)}</span>
              </div>
            </a>
          );
        }

        return (
          <button
            key={r.id}
            onClick={() => router.push(`/dashboard/returns/${r.id}`)}
            className={`flex w-full items-center justify-between ${variant === "bare" ? "py-2" : "px-4 py-2.5"} text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50`}
          >
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge}`}>{r.status}</span>
              <span className="text-sm text-zinc-900 dark:text-zinc-100">{r.order_number}</span>
              <span className="text-xs text-zinc-400">{resLabel}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm tabular-nums text-zinc-500">{formatCents(r.net_refund_cents)}</span>
              {showDate && <span className="text-xs text-zinc-400">{formatDate(r.created_at)}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
