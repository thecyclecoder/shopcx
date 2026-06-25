import Link from "next/link";
import { getGoals } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { GoalStatusBadge } from "./GoalStatusBadge";

// Reads docs/brain/goals + specs at request time — always reflects the live brain.

function RollupBar({ pct }: { pct: number }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>Rollup</span>
        <span className="tabular-nums font-medium text-zinc-700 dark:text-zinc-300">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

export default async function GoalsBoardPage() {
  const workspaceId = await getActiveWorkspaceId();
  const goals = await getGoals(workspaceId ?? undefined);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Goals</h1>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Taxonomy map →
          </Link>
          <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Board view →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Finite company initiatives (BHAGs) — each decomposes into milestones, each milestone into specs. The rollup % is the
        mean of milestone completion and advances automatically as leaf specs ship. Reads <code>docs/brain/goals/</code>.
      </p>

      {goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No goals in <code>docs/brain/goals/</code> yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {goals.map((g) => (
            <Link
              key={g.slug}
              href={`/dashboard/roadmap/goals/${g.slug}`}
              className="group flex flex-col rounded-xl border border-zinc-200 bg-white p-4 shadow-sm hover:border-indigo-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-sm font-semibold text-zinc-900 group-hover:text-indigo-600 dark:text-zinc-100 dark:group-hover:text-indigo-400">
                  {g.title}
                </h2>
                <GoalStatusBadge status={g.status} proposedBy={g.proposedBy} />
              </div>
              {g.successMetric && (
                <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium text-zinc-600 dark:text-zinc-300">Success:</span> {g.successMetric}
                </p>
              )}
              <RollupBar pct={g.pct} />
              <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
                <span className="tabular-nums">{g.milestones.length} milestones</span>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className="tabular-nums">{g.linkedSpecCount} specs linked</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
