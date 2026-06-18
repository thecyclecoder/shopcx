import Link from "next/link";
import { getGoals } from "@/lib/brain-roadmap";

// Reads docs/brain/goals + specs at request time — rollup always reflects the live brain.
export const dynamic = "force-dynamic";

function pct(n: number): number {
  return Math.round(n * 100);
}

function RollupBar({ value }: { value: number }) {
  const p = pct(value);
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Rollup</span>
        <span className="font-medium tabular-nums">{p}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

export default async function GoalsBoardPage() {
  const goals = await getGoals();

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Goals</h1>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/dashboard/roadmap/map" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">Map view →</Link>
          <Link href="/dashboard/roadmap" className="text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">Board view →</Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Finite company initiatives (BHAGs). Each rolls up to 100% from its linked specs&apos; phase completion, then closes.
        Open a goal and tap <span className="font-medium">Plan</span> to decompose it into a milestone → spec tree. Reads <code>docs/brain/goals/</code>.
      </p>

      {goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No goals in <code>docs/brain/goals/</code> yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {goals.map(({ goal, rollup, milestoneViews }) => (
            <Link
              key={goal.slug}
              href={`/dashboard/roadmap/goals/${goal.slug}`}
              className="group rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
            >
              <h2 className="text-sm font-semibold leading-snug text-zinc-900 group-hover:text-indigo-600 dark:text-zinc-100 dark:group-hover:text-indigo-400">
                {goal.title}
              </h2>
              {goal.summary && <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{goal.summary}</p>}
              {goal.successMetric && (
                <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium text-zinc-600 dark:text-zinc-300">Success:</span> {goal.successMetric}
                </p>
              )}
              <RollupBar value={rollup} />
              <div className="mt-2 flex items-center gap-3 text-[11px] text-zinc-400">
                <span>{milestoneViews.length} milestone{milestoneViews.length === 1 ? "" : "s"}</span>
                <span>{goal.specSlugs.length} spec{goal.specSlugs.length === 1 ? "" : "s"}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
