"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "./format-utils";

export interface ReplacementItem {
  id: string;
  original_order_number: string | null;
  shopify_replacement_order_name: string | null;
  reason: string;
  reason_detail: string | null;
  status: string;
  customer_error: boolean;
  items: { title: string; quantity: number }[] | null;
  created_at: string;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  address_confirmed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  created: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  denied: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const FALLBACK_BADGE = "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";

const REASON_LABELS: Record<string, string> = {
  delivery_error: "Delivery Error",
  missing_items: "Missing Items",
  damaged_items: "Damaged Items",
  wrong_address: "Wrong Address",
  carrier_lost: "Carrier Lost",
  not_received: "Not Received",
  refused: "Refused",
};

interface Props {
  replacements: ReplacementItem[];
  loading?: boolean;
  compact?: boolean;
}

export function ReplacementsList({ replacements, loading, compact }: Props) {
  const router = useRouter();

  if (loading) return <p className="py-4 text-center text-sm text-zinc-400">Loading replacements...</p>;
  if (replacements.length === 0) return <p className="py-4 text-center text-sm text-zinc-400">No replacements</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-100 text-left text-xs font-medium uppercase text-zinc-400 dark:border-zinc-800">
            <th className="px-3 py-2">Original</th>
            <th className="px-3 py-2">Reason</th>
            <th className="px-3 py-2">Status</th>
            {!compact && <th className="px-3 py-2">Replacement</th>}
            <th className="px-3 py-2">Date</th>
          </tr>
        </thead>
        <tbody>
          {replacements.map(r => (
            <tr
              key={r.id}
              onClick={() => router.push(`/dashboard/replacements/${r.id}`)}
              className="cursor-pointer border-b border-zinc-50 transition-colors hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
            >
              <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                {r.original_order_number || "—"}
              </td>
              <td className="px-3 py-2">
                <span className="text-xs text-zinc-700 dark:text-zinc-300">
                  {REASON_LABELS[r.reason] || r.reason}
                </span>
                {r.customer_error && (
                  <span className="ml-1.5 inline-block rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
                    CX
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status] || FALLBACK_BADGE}`}>
                  {r.status.replace("_", " ")}
                </span>
              </td>
              {!compact && (
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {r.shopify_replacement_order_name || "—"}
                </td>
              )}
              <td className="whitespace-nowrap px-3 py-2 text-xs text-zinc-400">{formatDate(r.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
