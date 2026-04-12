"use client";

export interface ChargebackItem {
  id: string;
  reason: string;
  status: string;
  amount_cents: number;
  shopify_order_id: string | null;
  order_number?: string | null;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  open: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  won: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  lost: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  under_review: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

export default function ChargebacksList({ chargebacks, compact }: { chargebacks: ChargebackItem[]; compact?: boolean }) {
  if (!chargebacks.length) return null;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      {chargebacks.map(cb => {
        const date = new Date(cb.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const statusCls = STATUS_COLORS[cb.status] || STATUS_COLORS.open;
        return (
          <div key={cb.id} className={`flex items-center justify-between ${compact ? "rounded bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800" : "rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {cb.order_number && <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">#{cb.order_number}</span>}
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusCls}`}>{cb.status.replace(/_/g, " ")}</span>
              </div>
              <p className="mt-0.5 text-xs text-zinc-400 capitalize">{(cb.reason || "unknown").replace(/_/g, " ")}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium text-red-600 dark:text-red-400">${((cb.amount_cents || 0) / 100).toFixed(2)}</p>
              <p className="text-[10px] text-zinc-400">{date}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
