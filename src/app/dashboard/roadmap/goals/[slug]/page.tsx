import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import {
  getGoal,
  listSpecSlugs,
  listGoalSlugs,
  listFunctionSlugs,
  type SpecStatus,
  type SpecCard,
} from "@/lib/brain-roadmap";
import { GoalStatusBadge } from "../GoalStatusBadge";
import { preprocessBrainWikilinks } from "@/lib/brain-links";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestPlanJob } from "@/lib/agent-jobs";
import PlanButton from "../../PlanButton";


const DOT: Record<SpecStatus, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  in_review: "bg-slate-400",
  shipped: "bg-emerald-500",
  deferred: "bg-slate-400",
  rejected: "bg-rose-400",
};

function SpecChip({ spec }: { spec: SpecCard }) {
  return (
    <Link
      href={`/dashboard/roadmap/${spec.slug}`}
      className="group inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
    >
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[spec.status]}`} />
      <span className="text-xs leading-snug text-zinc-700 group-hover:text-indigo-600 dark:text-zinc-300 dark:group-hover:text-indigo-400">
        {spec.title}
      </span>
    </Link>
  );
}

export default async function GoalDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspaceId = await getActiveWorkspaceId();
  const [goal, specSlugs, goalSlugs, functionSlugs] = await Promise.all([
    getGoal(slug, workspaceId ?? undefined),
    listSpecSlugs(),
    listGoalSlugs(),
    listFunctionSlugs(),
  ]);
  if (!goal) notFound();

  const planJob = workspaceId ? await getLatestPlanJob(workspaceId, slug) : null;
  const html = await marked.parse(preprocessBrainWikilinks(goal.raw, { specSlugs, goalSlugs, functionSlugs }));
  const { card, specs } = goal;

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Goals
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: the rendered goal doc */}
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Sidebar: rollup, plan control, milestone tree with live spec status */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-medium uppercase tracking-wide">Rollup</span>
                <span className="tabular-nums font-semibold text-zinc-800 dark:text-zinc-200">{card.pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.max(2, card.pct)}%` }} />
              </div>
              <div className="mt-1.5 text-[11px] text-zinc-400">
                {card.milestones.length} milestones · {card.linkedSpecCount} specs linked
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</span>
              <GoalStatusBadge status={card.status} proposedBy={card.proposedBy} />
            </div>

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <PlanButton goalSlug={slug} initialJob={planJob} goalStatus={card.status} />
            </div>

            {card.milestones.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Milestone tree</div>
                <div className="space-y-3">
                  {card.milestones.map((m, i) => {
                    const linked = m.specSlugs.map((s) => specs[s]).filter((s): s is SpecCard => !!s);
                    const pct = Math.round(m.completion * 100);
                    return (
                      <div key={i}>
                        <div className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[m.status]}`} />
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            {m.id && <span className="text-zinc-400">{m.id} · </span>}
                            {m.name}
                          </span>
                          <span className="ml-auto text-[10px] tabular-nums text-zinc-400">{pct}%</span>
                        </div>
                        {m.metric && <div className="ml-3 mt-0.5 text-[10px] text-zinc-400">metric: {m.metric}</div>}
                        {linked.length > 0 && (
                          <div className="ml-3 mt-1 flex flex-wrap gap-1.5">
                            {linked.map((s) => <SpecChip key={s.slug} spec={s} />)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <code className="block text-[11px] text-zinc-400">docs/brain/goals/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
