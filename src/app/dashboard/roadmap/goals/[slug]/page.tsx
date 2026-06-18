import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getGoal, listSpecSlugs, listGoalSlugs, listFunctionSlugs, type Phase } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug } from "@/lib/agent-jobs";
import PlanButton from "../PlanButton";

export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};

/** Link [[wikilinks]] to the right detail page (spec / goal / function), else plain text. */
function preprocessWikilinks(md: string, specs: string[], goals: string[], fns: string[]): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const base = targetRaw.trim().replace(/^.*\//, "").replace(/\.md$/, "");
    const label = (alias || base).trim();
    if (specs.includes(base)) return `[${label}](/dashboard/roadmap/${base})`;
    if (goals.includes(base)) return `[${label}](/dashboard/roadmap/goals/${base})`;
    if (fns.includes(base)) return `[${label}](/dashboard/roadmap/functions/${base})`;
    return label;
  });
}

export default async function GoalDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [goal, specSlugs, goalSlugs, fnSlugs, workspaceId] = await Promise.all([
    getGoal(slug),
    listSpecSlugs(),
    listGoalSlugs(),
    listFunctionSlugs(),
    getActiveWorkspaceId(),
  ]);
  if (!goal) notFound();
  const { raw, resolved } = goal;
  const { goal: card, rollup, milestoneViews } = resolved;

  const jobsBySlug = workspaceId ? await getLatestJobsBySlug(workspaceId) : {};
  const job = jobsBySlug[slug] ?? null;

  const html = await marked.parse(preprocessWikilinks(raw, specSlugs, goalSlugs, fnSlugs));
  const p = Math.round(rollup * 100);

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">← Goals</Link>
        <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">Board →</Link>
      </div>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span>Rollup</span>
                <span className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{p}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${p}%` }} />
              </div>
              {card.successMetric && <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-300">Success:</span> {card.successMetric}</p>}
              {card.target && <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400"><span className="font-medium text-zinc-600 dark:text-zinc-300">Target:</span> {card.target}</p>}
            </div>

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <PlanButton goalSlug={slug} initialJob={job} />
            </div>

            {milestoneViews.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Milestones → specs</div>
                <ol className="space-y-2">
                  {milestoneViews.map((mv, i) => (
                    <li key={i} className="text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[mv.milestone.status]}`} />
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">
                          {mv.milestone.id && <span className="text-zinc-400">{mv.milestone.id} · </span>}
                          {mv.milestone.title}
                        </span>
                        {mv.specs.length > 0 && <span className="ml-auto tabular-nums text-zinc-400">{Math.round(mv.rollup * 100)}%</span>}
                      </div>
                      {mv.specs.length > 0 && (
                        <ul className="ml-3 mt-0.5 space-y-0.5 border-l border-zinc-100 pl-2 dark:border-zinc-800">
                          {mv.specs.map((s) => (
                            <li key={s.slug}>
                              <Link href={`/dashboard/roadmap/${s.slug}`} className="group flex items-center gap-1.5">
                                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[s.status]}`} />
                                <span className="text-zinc-600 group-hover:text-indigo-600 dark:text-zinc-400 dark:group-hover:text-indigo-400">{s.title}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-800">
              <code>docs/brain/goals/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
