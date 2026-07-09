import Link from "next/link";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { getSpec, listSpecSlugs, getRoadmapFilters, type SpecStatus } from "@/lib/brain-roadmap";
import { getSpec as getSpecRow } from "@/lib/specs-table";
import { listSpecPhaseChecks } from "@/lib/spec-phase-checks-table";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug, getPendingFolds, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import {
  getLatestSpecTestRuns,
  getHumanCheckResolutions,
  getLiveSpecTestSlugs,
  deriveGreenBullets,
  type SpecTestRun,
} from "@/lib/spec-test-runs";
import { getSecurityStateBySlug } from "@/lib/security-agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTimecard, type TimecardView } from "@/lib/spec-timecards";
import { readMarioThresholds, type MarioThreshold } from "@/lib/mario";
import { deriveLifecycleStage } from "@/lib/build-lifecycle";
import { buildLifecycleContext, lifecyclePillForCurrent } from "@/lib/build-lifecycle-context";
import LifecycleTimeline, { type WaitDisplay } from "../LifecycleTimeline";
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

  // spec-detail-timecard-timeline Phase 1 — load the M1 timecard + workspace mario_thresholds
  // alongside the existing per-workspace loads so LifecycleTimeline can paint per-stage duration
  // + inter-stage gap pills without a second server round-trip.
  const [jobsBySlug, folds, testRuns, resolutions, liveSpecTestSlugs, securityBySlug, timecard, marioThresholds] = workspaceId
    ? await Promise.all([
        getLatestJobsBySlug(workspaceId),
        getPendingFolds(workspaceId),
        getLatestSpecTestRuns(workspaceId),
        getHumanCheckResolutions(workspaceId),
        getLiveSpecTestSlugs(workspaceId),
        getSecurityStateBySlug(createAdminClient(), workspaceId),
        getTimecard(createAdminClient(), workspaceId, slug).catch(
          () => ({ spec_slug: slug, steps: [], open_waits: [], total_elapsed_ms: 0, first_event_at: null, terminal_at: null }) satisfies TimecardView,
        ),
        readMarioThresholds(createAdminClient(), workspaceId).catch(() => [] as MarioThreshold[]),
      ])
    : [
        {} as Record<string, AgentJob>,
        {} as Record<string, PendingFold>,
        {} as Record<string, SpecTestRun>,
        new Map<string, import("@/lib/spec-test-runs").HumanCheckRow>(),
        new Set<string>() as ReadonlySet<string>,
        {} as Record<string, import("@/lib/security-agent").SecurityStateBySlug>,
        { spec_slug: slug, steps: [], open_waits: [], total_elapsed_ms: 0, first_event_at: null, terminal_at: null } satisfies TimecardView,
        [] as MarioThreshold[],
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

  // spec-detail-timecard-timeline Phase 2 / Fix 1 — resolve every open_wait row on the timecard
  // into a friendly WaitDisplay label BEFORE render, so the WaitRow never surfaces a raw slug
  // or UUID. Owner-id (UUID-shaped) `waiting_on` → workspace_members.display_name via a single
  // query for THIS spec's open-wait owner ids. `ceo` → "CEO". `max-usage` → "Max usage cap".
  // A dep slug → the linked title from spec.card.blockedBy (already resolved by getSpec).
  const openWaits = timecard.open_waits;
  const ownerIds = new Set<string>();
  for (const w of openWaits) {
    if (w.waiting_on && /^[0-9a-f-]{36}$/i.test(w.waiting_on)) ownerIds.add(w.waiting_on);
  }
  const displayNameById = new Map<string, string>();
  if (workspaceId && ownerIds.size > 0) {
    const admin = createAdminClient();
    const { data: members } = await admin
      .from("workspace_members")
      .select("id, display_name")
      .eq("workspace_id", workspaceId)
      .in("id", Array.from(ownerIds));
    for (const m of (members ?? []) as Array<{ id: string; display_name: string | null }>) {
      if (m.display_name) displayNameById.set(m.id, m.display_name);
    }
  }
  const blockedByTitleBySlug = new Map<string, string>();
  for (const b of spec.card.blockedBy) blockedByTitleBySlug.set(b.slug, b.title || b.slug);
  const resolveWaitingOn = (wait_kind: string, waiting_on: string | null): string => {
    const v = (waiting_on ?? "").trim();
    if (wait_kind === "blocked_on_usage" || v.toLowerCase() === "max-usage") return "Max usage cap";
    if (v.toLowerCase() === "ceo") return "CEO";
    if (displayNameById.has(v)) return displayNameById.get(v)!;
    if (blockedByTitleBySlug.has(v)) return blockedByTitleBySlug.get(v)!;
    return v || wait_kind;
  };
  const waits: WaitDisplay[] = openWaits.map((w) => {
    // The wait-row SLA is the (wait_kind → wait_exited) row on mario_thresholds when configured.
    // No matching row → sky/neutral in WaitRow.
    const t = marioThresholds.find((mt) => mt.from_event === w.wait_kind && mt.to_event === "wait_exited");
    return {
      wait_kind: w.wait_kind,
      waiting_on_display: resolveWaitingOn(w.wait_kind, w.waiting_on),
      entered_at: w.entered_at,
      gap_ms: w.gap_ms,
      sla_ms: t ? t.sla_ms : null,
    };
  });
  // A folded / short-circuited spec renders "Total: <static>" in place of the live-ticking
  // "Elapsed:" — {@link TimecardView.terminal_at} is set when the ledger has a terminal marker
  // (`folded` or `phase_shipped`), so no client tick fires on a finished spec.
  const timelineTerminal = timecard.terminal_at !== null;

  // Phase 3 (spec-test-maximize-machine-coverage) — live per-check green state — green when the agent
  // passed it OR the owner marked it ✓ Tested. Rendered directly from the DB
  // (spec_phase_checks rows + spec_test_runs + spec_test_human_checks); no markdown parse under
  // pm-structured-intent-and-refs Phase 4. Falls back to spec_phases.verification only until the rows
  // are backfilled — still a DB column read, never a parse of the rendered body.
  const specRow = workspaceId ? await getSpecRow(workspaceId, slug) : null;
  const phaseChecks = specRow
    ? await listSpecPhaseChecks({
        phases: specRow.phases.map((p) => ({ id: p.id, position: p.position, verification: p.verification })),
      })
    : [];
  const greenBullets = deriveGreenBullets(phaseChecks.map((c) => c.text), testRun, resolutions, slug);
  const allGreen = greenBullets.length > 0 && greenBullets.every((g) => g.green);

  // The verification test plan is rendered from the ROWS, not lifted out of the body — the detail
  // page's "build detail" article shows the full rendered spec unchanged.
  const verificationHtml = phaseChecks.length
    ? await marked.parse(
        preprocessWikilinks(phaseChecks.map((c) => `- ${c.text}`).join("\n"), specSlugs),
      )
    : null;

  // Trusted internal content (our own brain markdown), owner-only page → marked → prose.
  const html = await marked.parse(preprocessWikilinks(spec.raw, specSlugs));

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
                  rendered here too (one shared component across the board card + detail card).
                  spec-detail-timecard-timeline Phase 1 — the same mount point now paints per-stage
                  duration + inter-stage gap pills off the M1 timecard + mario_thresholds SLA. */}
              <LifecycleTimeline
                derivation={derivation}
                currentLabel={pill.label}
                currentTitle={pill.title}
                timecard={timecard}
                thresholds={marioThresholds}
                waits={waits}
                terminal={timelineTerminal}
              />
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
