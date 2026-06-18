import Link from "next/link";
import { getGoals, type GoalCard, type Phase } from "@/lib/brain-roadmap";

// Reads docs/brain/goals + specs at request time — always reflects the live brain.
export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};
const STATUS_LABEL: Record<Phase, string> = { planned: "Planned", in_progress: "In progress", shipped: "Closed", rejected: "Cut" };

function pct(n: number): number {
  return Math.round(n * 100);
}

function GoalCardView({ goal }: { goal: GoalCard }) {
  return (
    <Link
      href={`/dashboard/roadmap/goals/${goal.slug}`}
      className="group block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 group-hover:text-indigo-600 dark:text-zinc-100 dark:group-hover:text-indigo-400">
          {goal.title}
        </h2>
        <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[goal.status]}`} />
          {STATUS_LABEL[goal.status]}
        </span>
      </div>
      {goal.successMetric && (
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">Success:</span> {goal.successMetric}
        </p>
      )}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-400">
          <span>{goal.milestones.length} milestones</span>
          <span className="tabular-nums">{pct(goal.completion)}%</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct(goal.completion)}%` }} />
        </div>
      </div>
    </Link>
  );
}

export default async function GoalsBoardPage() {
  const goals = await getGoals();

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Goals</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/dashboard/roadmap/map" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Map view
          </Link>
          <Link href="/dashboard/roadmap" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Board view →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Finite company initiatives (BHAGs) from <code>docs/brain/goals/</code>. Each rolls up to a % from its
        linked specs&apos; phase completion. Open one and tap <span className="font-medium">Plan</span> to decompose it
        into a milestone → spec tree (human-gated).
      </p>

      {goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No goals in <code>docs/brain/goals/</code> yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {goals.map((g) => (
            <GoalCardView key={g.slug} goal={g} />
          ))}
        </div>
      )}
    </div>
  );
}
