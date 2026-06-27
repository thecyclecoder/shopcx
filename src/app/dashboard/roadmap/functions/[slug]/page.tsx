import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import {
  getFunction,
  listSpecSlugs,
  listGoalSlugs,
  listFunctionSlugs,
  type SpecStatus,
} from "@/lib/brain-roadmap";
import { preprocessBrainWikilinks } from "@/lib/brain-links";


const DOT: Record<SpecStatus, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  in_testing: "bg-sky-500",
  in_review: "bg-slate-400",
  shipped: "bg-emerald-500",
  deferred: "bg-slate-400",
  rejected: "bg-rose-400",
};

export default async function FunctionDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [fn, specSlugs, goalSlugs, functionSlugs] = await Promise.all([
    getFunction(slug),
    listSpecSlugs(),
    listGoalSlugs(),
    listFunctionSlugs(),
  ]);
  if (!fn) notFound();

  const html = await marked.parse(preprocessBrainWikilinks(fn.raw, { specSlugs, goalSlugs, functionSlugs }));
  const { card, group } = fn;
  // Active specs across the function (planned + in progress) — a mandate is perpetual (no %),
  // so it surfaces this count + its metric rather than a rollup.
  const activeCount = group ? group.counts.planned + group.counts.in_progress : 0;

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Taxonomy map
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: the rendered function charter */}
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Sidebar: mandates (metric + spec count, perpetual — no %) + owned/contributed goals */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {card.title}
              </span>
              <span className="text-[11px] text-zinc-400">{activeCount} active specs</span>
            </div>

            {card.mandates.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Mandates (perpetual)
                </div>
                <div className="space-y-3">
                  {card.mandates.map((m, i) => {
                    const group2 = group?.groups.find((g) => g.label === m.name || g.parent.includes(m.name));
                    const specs = group2?.specs ?? [];
                    return (
                      <div key={i}>
                        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{m.name}</div>
                        {m.metric && <div className="mt-0.5 text-[10px] text-zinc-400">metric: {m.metric}</div>}
                        {specs.length > 0 && (
                          <div className="ml-1 mt-1 space-y-0.5">
                            {specs.map((s) => (
                              <Link key={s.slug} href={`/dashboard/roadmap/${s.slug}`} className="group flex items-center gap-1.5">
                                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[s.status]}`} />
                                <span className="truncate text-[11px] text-zinc-600 group-hover:text-indigo-600 dark:text-zinc-400 dark:group-hover:text-indigo-400">
                                  {s.title}
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {card.goalSlugs.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Owned / contributed goals
                </div>
                <div className="space-y-1">
                  {card.goalSlugs.map((gs) => (
                    <Link
                      key={gs}
                      href={`/dashboard/roadmap/goals/${gs}`}
                      className="block truncate text-[11px] text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {gs} ↗
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <code className="block text-[11px] text-zinc-400">docs/brain/functions/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
