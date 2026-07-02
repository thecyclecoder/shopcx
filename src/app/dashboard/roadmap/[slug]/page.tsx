import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getSpec, listSpecSlugs, getRoadmapFilters, extractSpecSection, stripSpecSection, type SpecStatus } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug, getPendingFolds, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import {
  getLatestSpecTestRuns,
  getHumanCheckResolutions,
  getLiveSpecTestSlugs,
  parseVerificationBullets,
  deriveGreenBullets,
  type SpecTestRun,
} from "@/lib/spec-test-runs";
import { getSecurityStateBySlug } from "@/lib/security-agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveLifecycleStage } from "@/lib/build-lifecycle";
import { buildLifecycleContext, lifecyclePillForCurrent } from "@/lib/build-lifecycle-context";
import LifecycleTimeline from "../LifecycleTimeline";
import BranchPosition from "../BranchPosition";
import StatusControl from "../StatusControl";
import PriorityControl from "../PriorityControl";
import AuthoringChat from "../AuthoringChat";
import BuildButton from "../BuildButton";
import PhaseList from "../PhaseList";
import VerificationCard from "../VerificationCard";


const STATUS_LABEL: Record<SpecStatus, string> = { planned: "Planned", in_progress: "In progress", in_testing: "In testing", in_review: "In Review", shipped: "Shipped", deferred: "Deferred", rejected: "Cut" };
const STATUS_BADGE: Record<SpecStatus, string> = {
  planned: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  in_testing: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  in_review: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  shipped: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  deferred: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

/** [[spec-slug]] / [[../lifecycles/x|alias]] → a link to the spec detail page if it's a spec, else plain text. */
function preprocessWikilinks(md: string, specSlugs: string[]): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const base = targetRaw.trim().replace(/^.*\//, "").replace(/\.md$/, "");
    const label = (alias || base).trim();
    return specSlugs.includes(base) ? `[${label}](/dashboard/roadmap/${base})` : label;
  });
}

export default async function SpecDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const workspaceId = await getActiveWorkspaceId();
  // spec-status-db-driven Phase 1: getSpec(slug, workspaceId) overlays the DB mirror's status / critical
  // / deferred / per-phase status onto the markdown card — the detail page reads DB-authoritatively.
  const [spec, specSlugs, filters] = await Promise.all([
    getSpec(slug, workspaceId ?? undefined),
    listSpecSlugs(),
    // spec-goal-branch-pm-flow M6 — goal membership for the branch-flow timeline (a goal-bound spec renders
    // the "on goal branch" step; a one-off promotes straight to main).
    getRoadmapFilters(workspaceId ?? undefined),
  ]);
  if (!spec) notFound();
  const goalBound = (filters.goalsBySpec[slug] ?? []).length > 0;

  const [jobsBySlug, folds, testRuns, resolutions, liveSpecTestSlugs, securityBySlug] = workspaceId
    ? await Promise.all([
        getLatestJobsBySlug(workspaceId),
        getPendingFolds(workspaceId),
        getLatestSpecTestRuns(workspaceId),
        getHumanCheckResolutions(workspaceId),
        getLiveSpecTestSlugs(workspaceId),
        getSecurityStateBySlug(createAdminClient(), workspaceId),
      ])
    : [
        {} as Record<string, AgentJob>,
        {} as Record<string, PendingFold>,
        {} as Record<string, SpecTestRun>,
        new Map<string, import("@/lib/spec-test-runs").HumanCheckRow>(),
        new Set<string>() as ReadonlySet<string>,
        {} as Record<string, import("@/lib/security-agent").SecurityStateBySlug>,
      ];
  // spec-readers-from-db-retire-parser Phase 3: per-phase status + PR/merge_sha provenance come straight off
  // the DB-sourced `spec.card.phases` (dbRowToSpecCard maps `public.spec_phases` rows) — the legacy
  // `mergePhaseStates` overlay onto the retired `spec_card_state.phase_states` slot is gone.
  const phases = spec.card.phases;
  const job = jobsBySlug[slug] ?? null;
  const fold = folds[slug] ?? null;
  const testRun = testRuns[slug] ?? null;

  // build-card-lifecycle-timeline Phase 2 — the same 5-node timeline the board card renders, here on the
  // detail "build/spec card" (one shared component per the reusable-components rule). The detail page
  // only resolves boardable specs (getSpec filters folded), so `folded: false` is always correct here.
  const lifecycleCtx = buildLifecycleContext({
    spec: spec.card,
    job,
    testRun,
    humanResolutions: resolutions,
    liveSpecTestSlugs,
    security: securityBySlug[slug],
    folded: false,
  });
  const derivation = deriveLifecycleStage(lifecycleCtx);
  const pill = lifecyclePillForCurrent(derivation, job, fold, lifecycleCtx.valePass);

  // Phase 3 (spec-test-maximize-machine-coverage): live per-bullet green state — green when the agent
  // passed it OR the owner marked it ✓ Tested. Rendered directly from the DB
  // (spec_test_runs + spec_test_human_checks); no markdown commit under 'DB is the spec'.
  const greenBullets = deriveGreenBullets(
    parseVerificationBullets(spec.raw).map((b) => b.text),
    testRun,
    resolutions,
    slug,
  );
  const allGreen = greenBullets.length > 0 && greenBullets.every((g) => g.green);

  // The "## Verification" test plan (verification-guides) is lifted out of the body and shown as a
  // prominent card beside the verify button; strip it from the article so it isn't rendered twice.
  const verification = extractSpecSection(spec.raw, "Verification");
  const verificationHtml = verification
    ? await marked.parse(preprocessWikilinks(verification, specSlugs))
    : null;

  // Trusted internal content (our own brain markdown), owner-only page → marked → prose.
  const html = await marked.parse(preprocessWikilinks(stripSpecSection(spec.raw, "Verification"), specSlugs));

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
        ← Roadmap
      </Link>

      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Main: intent-first header then the rendered spec body.
            pm-structured-intent-and-refs Phase 4 — the detail page LEADS with plain-language
            what + why (the shared intent both humans + agents read), then the phase list, and
            only THEN drops into the technical body/build detail. Legacy rows without `what`/`why`
            fall back to the summary + rendered body (no visible regression). */}
        <div className="order-2 lg:order-1">
          {(spec.card.what || spec.card.why || spec.card.summary) && (
            <section className="mb-5 rounded-lg border border-zinc-200 bg-white/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
              <h1 className="text-lg font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
                {spec.card.title}
              </h1>
              {spec.card.what && (
                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{spec.card.what}</p>
              )}
              {spec.card.why && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
                    Why this exists
                  </summary>
                  <p className="mt-2 whitespace-pre-line text-zinc-700 dark:text-zinc-300">{spec.card.why}</p>
                </details>
              )}
              {!spec.card.what && !spec.card.why && spec.card.summary && (
                <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">{spec.card.summary}</p>
              )}
            </section>
          )}
          <details className="mb-4">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
              Build detail
            </summary>
            <article
              className="prose prose-sm prose-zinc mt-3 max-w-none prose-headings:font-semibold prose-pre:bg-zinc-900 prose-pre:text-zinc-100 prose-code:before:content-none prose-code:after:content-none prose-table:text-xs"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </details>
        </div>

        {/* Sidebar: status, build actions, phases — the same controls as the board card */}
        <aside className="order-1 self-start lg:sticky lg:top-6 lg:order-2">
          <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[spec.card.status]}`}>
                {STATUS_LABEL[spec.card.status]}
              </span>
              {/* spec-status-phase-pr-provenance Phase 3: card-level shipping PR (one-shot specs).
                  Multi-phase specs surface per-phase PRs via PhaseList below instead. */}
              {spec.card.status === "shipped" && spec.card.phases.length === 0 && spec.card.shippedPr && (
                <a
                  href={`https://github.com/thecyclecoder/shopcx/pull/${spec.card.shippedPr}`}
                  target="_blank"
                  rel="noreferrer"
                  title={`Shipped by PR #${spec.card.shippedPr}`}
                  className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
                >
                  #{spec.card.shippedPr}
                </a>
              )}
              <StatusControl slug={slug} status={spec.card.status} />
              <PriorityControl slug={slug} status={spec.card.status} critical={spec.card.critical} />
            </div>

            {/* spec-goal-branch-pm-flow M6 — where this spec sits in the branch flow (built on branch →
                in_testing → on goal branch → promoted to main). Same shared timeline the board card renders. */}
            <BranchPosition spec={spec.card} goalBound={goalBound} />

            {(spec.card.owner || spec.card.parent) && (
              <div className="space-y-1 border-t border-zinc-100 pt-3 text-xs dark:border-zinc-800">
                {spec.card.owner && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400">Owner</span>
                    <Link
                      href={`/dashboard/roadmap/functions/${spec.card.owner}`}
                      className="inline-flex items-center rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50"
                    >
                      {spec.card.owner}
                    </Link>
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
              {/* build-card-lifecycle-timeline Phase 2 — the 5-node timeline replacing the floating pill,
                  rendered here too (one shared component across the board card + detail card). */}
              <LifecycleTimeline derivation={derivation} currentLabel={pill.label} currentTitle={pill.title} />
              <BuildButton slug={slug} initialJob={job} specStatus={spec.card.status} initialFold={fold} blockedBy={spec.card.blockedBy} />
              <div className="mt-3">
                <VerificationCard
                  slug={slug}
                  html={verificationHtml}
                  run={testRun ? { agent_verdict: testRun.agent_verdict, summary: testRun.summary, checks: testRun.checks, run_at: testRun.run_at } : null}
                  greenBullets={greenBullets}
                  allGreen={allGreen}
                />
              </div>
            </div>

            {spec.card.phases.length > 0 && (
              <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">Phases</div>
                <PhaseList slug={slug} phases={phases} />
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
