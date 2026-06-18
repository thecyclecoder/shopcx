import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getSpec, listSpecSlugs, listFunctionSlugs, listGoalSlugs, linkRoadmapWikilinks, type Phase } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug } from "@/lib/agent-jobs";
import StatusControl from "../StatusControl";
import AuthoringChat from "../AuthoringChat";
import BuildButton from "../BuildButton";
import PhaseList from "../PhaseList";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<Phase, string> = { planned: "Planned", in_progress: "In progress", shipped: "Shipped", rejected: "Cut" };
const STATUS_BADGE: Record<Phase, string> = {
  planned: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

export default async function SpecDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [spec, specSlugs, functionSlugs, goalSlugs, workspaceId] = await Promise.all([
    getSpec(slug),
    listSpecSlugs(),
    listFunctionSlugs(),
    listGoalSlugs(),
    getActiveWorkspaceId(),
  ]);
  if (!spec) notFound();

  const jobsBySlug = workspaceId ? await getLatestJobsBySlug(workspaceId) : {};
  const job = jobsBySlug[slug] ?? null;
  const ownerIsFunction = spec.card.owner ? functionSlugs.includes(spec.card.owner) : false;

  // Trusted internal content (our own brain markdown), owner-only page → marked → prose.
  // Resolve [[wikilinks]] to spec / function / goal dashboard pages (the no-orphan taxonomy).
  const html = await marked.parse(linkRoadmapWikilinks(spec.raw, { specSlugs, functionSlugs, goalSlugs }));

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Roadmap
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main: the rendered spec */}
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {/* Sidebar: status, build actions, phases — the same controls as the board card */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[spec.card.status]}`}>
                {STATUS_LABEL[spec.card.status]}
              </span>
              <StatusControl slug={slug} status={spec.card.status} />
            </div>

            {(spec.card.owner || spec.card.parent) && (
              <div className="space-y-1 border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
                {spec.card.owner && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400">Owner</span>
                    {ownerIsFunction ? (
                      <Link
                        href={`/dashboard/roadmap/functions/${spec.card.owner}`}
                        className="inline-flex items-center rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300"
                      >
                        {spec.card.owner}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                        {spec.card.owner}
                      </span>
                    )}
                  </div>
                )}
                {spec.card.parent && (
                  <div className="flex items-start gap-1.5">
                    <span className="text-zinc-400">Parent</span>
                    <span className="text-zinc-500 dark:text-zinc-400">↳ {spec.card.parent}</span>
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <BuildButton slug={slug} initialJob={job} specStatus={spec.card.status} />
            </div>

            {spec.card.phases.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Phases</div>
                <PhaseList slug={slug} phases={spec.card.phases} />
              </div>
            )}

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <AuthoringChat slug={slug} triggerLabel="Refine with Opus" />
              <code className="mt-2 block text-[11px] text-zinc-400">docs/brain/specs/{slug}.md</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
