"use client";

export interface FraudCaseItem {
  id: string;
  severity: string;
  status: string;
  rule_type: string;
  created_at: string;
}

const SEVERITY_COLORS: Record<string, string> = {
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const STATUS_COLORS: Record<string, string> = {
  open: "text-amber-500",
  confirmed: "text-red-500",
  dismissed: "text-zinc-400",
};

export default function FraudCasesList({ cases, compact }: { cases: FraudCaseItem[]; compact?: boolean }) {
  if (!cases.length) return null;

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      {cases.map(fc => {
        const date = new Date(fc.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const sevCls = SEVERITY_COLORS[fc.severity] || SEVERITY_COLORS.low;
        const statusCls = STATUS_COLORS[fc.status] || STATUS_COLORS.open;
        return (
          <div key={fc.id} className={`flex items-center justify-between ${compact ? "rounded bg-zinc-50 px-2 py-1.5 dark:bg-zinc-800" : "rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"}`}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${sevCls}`}>{fc.severity}</span>
                <span className="text-xs text-zinc-700 dark:text-zinc-300 capitalize">{(fc.rule_type || "").replace(/_/g, " ")}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`text-xs font-medium capitalize ${statusCls}`}>{fc.status}</span>
              <span className="text-[10px] text-zinc-400">{date}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
