import Link from "next/link";
import { getGoals, getFoldedGoals } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { GoalStatusBadge } from "./GoalStatusBadge";
import { GreenlightButton } from "./GreenlightButton";
import GoalAccumulation from "./GoalAccumulation";

// Reads public.goals + public.goal_milestones (+ child specs) at request time — always reflects the
// live brain. The Archive section reads the folded goal rows (goal-fold-from-db-row Phase 2).

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
  const [goals, folded] = await Promise.all([
    getGoals(workspaceId ?? undefined),
    getFoldedGoals(workspaceId ?? undefined),
  ]);

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
        mean of milestone completion and advances automatically as leaf specs ship.
      </p>

      {goals.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No active goals yet.
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
                <div className="flex flex-col items-end gap-1.5">
                  <GoalStatusBadge status={g.status} proposedBy={g.proposedBy} />
                  <GreenlightButton slug={g.slug} status={g.status} hasProgress={g.pct > 0} compact />
                </div>
              </div>
              {g.successMetric && (
                <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium text-zinc-600 dark:text-zinc-300">Success:</span> {g.successMetric}
                </p>
              )}
              <RollupBar pct={g.pct} />
              {/* spec-goal-branch-pm-flow M6 — the goal-branch accumulation ("N of M specs on the goal
                  branch") + a "ready to promote" badge when fully accumulated. A parent goal shows the
                  sub-goals-promote-independently note instead. HELD state (Phase 2) supersedes both when
                  the atomic goal→main promotion 409'd or code isn't on main. */}
              <GoalAccumulation
                accumulation={g.accumulation}
                promotionHeld={g.promotionHeld}
                promotionHeldReason={g.promotionHeldReason}
              />
              <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
                <span className="tabular-nums">{g.milestones.length} milestones</span>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className="tabular-nums">{g.linkedSpecCount} specs linked</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {folded.length > 0 && (
        <section className="mt-10">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Archive</h2>
            <span className="tabular-nums text-[11px] text-zinc-400">{folded.length} folded</span>
          </div>
          <p className="mb-4 text-xs text-zinc-400 dark:text-zinc-500">
            Goals that completed and were folded into the permanent brain. The row is preserved — its durable knowledge also
            lives in the lifecycle / dashboard / function pages it touched.
          </p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {folded.map(({ card }) => (
              <Link
                key={card.slug}
                href={`/dashboard/roadmap/goals/${card.slug}`}
                className="group flex flex-col rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium text-zinc-700 group-hover:text-indigo-600 dark:text-zinc-300 dark:group-hover:text-indigo-400">
                    {card.title}
                  </h3>
                  <span className="inline-flex flex-shrink-0 items-center rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                    📦 Folded
                  </span>
                </div>
                {card.successMetric && (
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-zinc-400 dark:text-zinc-500">
                    <span className="font-medium text-zinc-500 dark:text-zinc-400">Success:</span> {card.successMetric}
                  </p>
                )}
                <div className="mt-3 flex items-center gap-2 text-[11px] text-zinc-400">
                  <span className="tabular-nums">{card.milestones.length} milestones</span>
                  <span className="text-zinc-300 dark:text-zinc-600">·</span>
                  <span className="tabular-nums">{card.linkedSpecCount} specs linked</span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
