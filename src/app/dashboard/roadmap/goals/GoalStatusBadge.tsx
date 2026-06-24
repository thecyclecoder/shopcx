import { functionLabel, type GoalStatus } from "@/lib/brain-roadmap";

// director-proposed-goals (Phase 2): the goal's lifecycle pill on the roadmap — `proposed` (a director
// authored it, awaiting the CEO's greenlight) vs `greenlit` (the CEO activated it) vs `complete`. A
// proposed goal also names its proposer, so you see what each director is proposing vs what you've activated.
// Server component (pure — no client state); rendered on the Goals board + the goal detail page.

const STYLE: Record<GoalStatus, string> = {
  proposed: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300",
  greenlit: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300",
  complete: "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300",
};

const LABEL: Record<GoalStatus, string> = { proposed: "⏳ Proposed", greenlit: "Greenlit", complete: "Complete" };

export function GoalStatusBadge({ status, proposedBy }: { status: GoalStatus; proposedBy?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${STYLE[status]}`}>
        {LABEL[status]}
      </span>
      {status === "proposed" && proposedBy && (
        <span className="text-[10px] text-zinc-400">by {functionLabel(proposedBy)}</span>
      )}
    </span>
  );
}
