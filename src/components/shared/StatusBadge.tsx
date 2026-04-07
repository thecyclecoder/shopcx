"use client";

const STATUS_MAP: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  refunded: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  partially_refunded: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  fulfilled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  // Delivery statuses
  delivered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  in_transit: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  awaiting_shipment: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  returned: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  unfulfilled: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const FALLBACK = "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

/**
 * Renders a colored pill badge for order financial/fulfillment status.
 * Used on customer detail, subscription detail, and ticket detail.
 */
export default function StatusBadge({ status, size = "xs" }: { status: string | null; size?: "xs" | "sm" }) {
  if (!status) return <span className="text-xs text-zinc-400">--</span>;
  const cls = STATUS_MAP[status] || FALLBACK;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-${size} font-medium capitalize ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
