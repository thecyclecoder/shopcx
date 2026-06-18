import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import {
  getGoal,
  getRoadmap,
  listSpecSlugs,
  listFunctionSlugs,
  listGoalSlugs,
  linkRoadmapWikilinks,
  type Milestone,
  type Phase,
  type SpecCard,
} from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestPlanJob } from "@/lib/agent-jobs";
import PlanButton from "../../PlanButton";

export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};

function pct(n: number): number {
  return Math.round(n * 100);
}

function SpecChip({ spec }: { spec: SpecCard }) {
  return (
    <Link
      href={`/dashboard/roadmap/${spec.slug}`}
      className="group inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-1.5 py-0.5 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
    >
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[spec.status]}`} />
      <span className="text-[11px] leading-snug text-zinc-700 group-hover:text-indigo-600 dark:text-zinc-300 dark:group-hover:text-indigo-400">
        {spec.title}
      </span>
    </Link>
  );
}

function MilestoneRow({ m, cards }: { m: Milestone; cards: Map<string, SpecCard> }) {
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${DOT[m.status]}`} />
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.title}</div>
            {m.detail && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{m.detail}</p>}
          </div>
        </div>
        <span className="whitespace-nowrap text-[11px] tabular-nums text-zinc-400">{pct(m.completion)}%</span>
      </div>
      {m.specSlugs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 pl-4">
          {m.specSlugs.map((s) => {
            const card = cards.get(s);
            return card ? (
              <SpecChip key={s} spec={card} />
            ) : (
              <span key={s} className="rounded-md border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700">
                {s} (missing)
              </span>
            );
          })}
        </div>
      )}
    </li>
  );
}

export default async function GoalDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [goal, { specs }, specSlugs, functionSlugs, goalSlugs, workspaceId] = await Promise.all([
    getGoal(slug),
    getRoadmap(),
    listSpecSlugs(),
    listFunctionSlugs(),
    listGoalSlugs(),
    getActiveWorkspaceId(),
  ]);
  if (!goal) notFound();

  const g = goal.card;
  const cards = new Map(specs.map((s) => [s.slug, s]));
  const planJob = workspaceId ? await getLatestPlanJob(workspaceId, slug) : null;
  const html = await marked.parse(linkRoadmapWikilinks(goal.raw, { specSlugs, functionSlugs, goalSlugs }));

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Goals
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: rendered goal doc */}
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Sidebar: rollup, plan, milestone tree */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-medium">Rollup</span>
                <span className="tabular-nums">{pct(g.completion)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct(g.completion)}%` }} />
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">Advances automatically as linked specs ship (✅).</p>
            </div>

            {g.successMetric && (
              <div className="border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
                <div className="text-zinc-400">Success metric</div>
                <div className="mt-0.5 text-zinc-600 dark:text-zinc-300">{g.successMetric}</div>
              </div>
            )}
            {g.target && (
              <div className="text-xs">
                <span className="text-zinc-400">Target </span>
                <span className="text-zinc-600 dark:text-zinc-300">{g.target}</span>
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <PlanButton goalSlug={slug} initialJob={planJob} />
            </div>

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <div className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Milestones <span className="tabular-nums text-zinc-400">{g.milestones.length}</span>
              </div>
              {g.milestones.length === 0 ? (
                <p className="text-xs text-zinc-400">No milestones yet — Plan to decompose.</p>
              ) : (
                <ul className="space-y-2">
                  {g.milestones.map((m) => (
                    <MilestoneRow key={m.id} m={m} cards={cards} />
                  ))}
                </ul>
              )}
              <code className="mt-3 block text-[11px] text-zinc-400">docs/brain/goals/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
