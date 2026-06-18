import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import {
  getFunction,
  getRoadmap,
  getGoals,
  listSpecSlugs,
  listFunctionSlugs,
  listGoalSlugs,
  linkRoadmapWikilinks,
  type Mandate,
  type Phase,
  type SpecCard,
} from "@/lib/brain-roadmap";

export const dynamic = "force-dynamic";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};

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

function MandateCard({ m, cards }: { m: Mandate; cards: Map<string, SpecCard> }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{m.title}</div>
        {/* Perpetual charter — no %, just the live "still emitting work" signal. */}
        <span className="whitespace-nowrap rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {m.activeSpecCount} active
        </span>
      </div>
      {m.metric && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">Metric:</span> {m.metric}
        </p>
      )}
      {m.specSlugs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {m.specSlugs.map((s) => {
            const card = cards.get(s);
            return card ? (
              <SpecChip key={s} spec={card} />
            ) : (
              <span key={s} className="rounded-md border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700">
                {s}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default async function FunctionDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [fn, { specs }, goals, specSlugs, functionSlugs, goalSlugs] = await Promise.all([
    getFunction(slug),
    getRoadmap(),
    getGoals(),
    listSpecSlugs(),
    listFunctionSlugs(),
    listGoalSlugs(),
  ]);
  if (!fn) notFound();

  const cards = new Map(specs.map((s) => [s.slug, s]));
  const linkedGoals = goals.filter((g) => fn.card.goalSlugs.includes(g.slug));
  const html = await marked.parse(linkRoadmapWikilinks(fn.raw, { specSlugs, functionSlugs, goalSlugs }));

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Taxonomy map
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main: rendered charter doc */}
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Sidebar: mandates + owned goals */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                {fn.card.label}
              </span>
              <span className="text-[11px] text-zinc-400">function</span>
            </div>

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <div className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Mandates <span className="tabular-nums text-zinc-400">{fn.card.mandates.length}</span>
              </div>
              {fn.card.mandates.length === 0 ? (
                <p className="text-xs text-zinc-400">No mandates parsed.</p>
              ) : (
                <div className="space-y-2">
                  {fn.card.mandates.map((m) => (
                    <MandateCard key={m.title} m={m} cards={cards} />
                  ))}
                </div>
              )}
            </div>

            {linkedGoals.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">Owned / contributed goals</div>
                <div className="space-y-1.5">
                  {linkedGoals.map((g) => (
                    <Link
                      key={g.slug}
                      href={`/dashboard/roadmap/goals/${g.slug}`}
                      className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                    >
                      <span className="text-zinc-700 hover:text-indigo-600 dark:text-zinc-300">{g.title}</span>
                      <span className="tabular-nums text-zinc-400">{Math.round(g.completion * 100)}%</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <code className="block border-t border-zinc-100 pt-3 text-[11px] text-zinc-400 dark:border-zinc-800">
              docs/brain/functions/{slug}.md
            </code>
          </div>
        </aside>
      </div>
    </div>
  );
}
