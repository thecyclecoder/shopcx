import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getFunction, listSpecSlugs, listGoalSlugs, listFunctionSlugs, functionLabel, type Phase } from "@/lib/brain-roadmap";

export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};

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

export default async function FunctionDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [fn, specSlugs, goalSlugs, fnSlugs] = await Promise.all([
    getFunction(slug),
    listSpecSlugs(),
    listGoalSlugs(),
    listFunctionSlugs(),
  ]);
  if (!fn) notFound();
  const { raw, card, mandateSpecs } = fn;

  const html = await marked.parse(preprocessWikilinks(raw, specSlugs, goalSlugs, fnSlugs));

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">← Map</Link>
        <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">Board →</Link>
      </div>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {functionLabel(slug)}
              </span>
              <span className="text-[11px] text-zinc-400">function · perpetual</span>
            </div>

            {mandateSpecs.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">Mandates (perpetual — no %, metric-tracked)</div>
                <div className="space-y-2.5">
                  {mandateSpecs.map((m, i) => (
                    <div key={i} className="text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-zinc-700 dark:text-zinc-300">{m.mandate.name}</span>
                        <span className="tabular-nums text-zinc-400">{m.active} active</span>
                      </div>
                      {m.mandate.metric && <p className="text-[11px] text-zinc-400">↻ {m.mandate.metric}</p>}
                      {m.specs.length > 0 && (
                        <ul className="ml-2 mt-0.5 space-y-0.5 border-l border-zinc-100 pl-2 dark:border-zinc-800">
                          {m.specs.map((s) => (
                            <li key={s.slug}>
                              <Link href={`/dashboard/roadmap/${s.slug}`} className="group flex items-center gap-1.5">
                                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[s.status]}`} />
                                <span className="text-zinc-600 group-hover:text-indigo-600 dark:text-zinc-400 dark:group-hover:text-indigo-400">{s.title}</span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {card.goalSlugs.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Owned / contributed goals</div>
                <ul className="space-y-0.5">
                  {card.goalSlugs.map((g) => (
                    <li key={g}>
                      <Link href={`/dashboard/roadmap/goals/${g}`} className="text-xs text-indigo-600 hover:underline dark:text-indigo-400">{g}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-800">
              <code>docs/brain/functions/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
