import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import {
  getGoal,
  getFoldedGoal,
  listSpecSlugs,
  listGoalSlugs,
  listFunctionSlugs,
  type SpecStatus,
  type SpecCard,
  type GoalCard,
} from "@/lib/brain-roadmap";
import { GoalStatusBadge } from "../GoalStatusBadge";
import { GreenlightButton } from "../GreenlightButton";
import GoalAccumulation from "../GoalAccumulation";
import { preprocessBrainWikilinks } from "@/lib/brain-links";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestPlanJob } from "@/lib/agent-jobs";
import PlanButton from "../../PlanButton";


const DOT: Record<SpecStatus, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  in_testing: "bg-sky-500",
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

  // goal-fold-from-db-row Phase 2: an active goal renders the live view; a FOLDED goal (getGoal returns
  // null) renders from its preserved row via getFoldedGoal — read-only, no greenlight/plan controls.
  if (!goal) {
    const archived = await getFoldedGoal(slug, workspaceId ?? undefined);
    if (!archived) notFound();
    const foldedHtml = await marked.parse(preprocessBrainWikilinks(archived.raw, { specSlugs, goalSlugs, functionSlugs }));
    return <FoldedGoalView card={archived.card} specs={archived.specs} html={foldedHtml} foldedAt={archived.updatedAt.slice(0, 10)} />;
  }

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
              {/* spec-goal-branch-pm-flow M6 — the goal-branch accumulation + atomic-promote readiness
                  (or the parent-goal exemption note). The detail variant adds the explanatory copy.
                  goal-promotion-fold-collision-and-held-surfacing Phase 2 — HELD supersedes ready-to-
                  promote / exempt when the atomic goal→main promotion 409'd or code isn't on main. */}
              <GoalAccumulation
                accumulation={card.accumulation}
                variant="detail"
                promotionHeld={card.promotionHeld}
                promotionHeldReason={card.promotionHeldReason}
              />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</span>
              <GoalStatusBadge status={card.status} proposedBy={card.proposedBy} />
            </div>

            <div className="flex justify-end">
              <GreenlightButton slug={slug} status={card.status} hasProgress={card.pct > 0} />
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
              <code className="block text-[11px] text-zinc-400">public.goals · {slug}</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// goal-fold-from-db-row Phase 2: a folded goal's read-only archive view — rendered from the preserved
// `public.goals` row (no greenlight / plan controls; the goal is done). The narrative body + milestone
// tree render exactly as they did pre-fold; only the status pill and the absent controls differ.
function FoldedGoalView({
  card,
  specs,
  html,
  foldedAt,
}: {
  card: GoalCard;
  specs: Record<string, SpecCard>;
  html: string;
  foldedAt: string;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Goals
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <article
          className="prose prose-sm prose-zinc order-2 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs lg:order-1"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/40">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</span>
              <span className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                📦 Folded · {foldedAt}
              </span>
            </div>

            <div className="rounded-md border border-zinc-200 bg-white p-2.5 text-[11px] leading-relaxed text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
              This goal completed and was folded into the permanent brain. Its durable knowledge lives in the lifecycle /
              dashboard / function pages it touched; this row is preserved as the archive.
            </div>

            <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <div className="mb-1 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-medium uppercase tracking-wide">Rollup</span>
                <span className="tabular-nums font-semibold text-zinc-800 dark:text-zinc-200">{card.pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-zinc-400 dark:bg-zinc-500" style={{ width: `${Math.max(2, card.pct)}%` }} />
              </div>
              <div className="mt-1.5 text-[11px] text-zinc-400">
                {card.milestones.length} milestones · {card.linkedSpecCount} specs linked
              </div>
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
              <code className="block text-[11px] text-zinc-400">public.goals · {card.slug} (folded)</code>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
