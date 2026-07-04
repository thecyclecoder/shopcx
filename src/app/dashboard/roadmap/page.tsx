import Link from "next/link";
import { getRoadmap, getArchive, getRoadmapFilters, type Phase, type SpecStatus, type SpecCard, type SpecSource } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug, getPendingFolds, reconcileMergedJobs, isActive, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import { getLatestSpecTestRuns, getHumanResolutionCounts, getHumanCheckResolutions, getLiveSpecTestSlugs, type SpecTestRun } from "@/lib/spec-test-runs";
import { getSecurityStateBySlug, type SecurityStateBySlug } from "@/lib/security-agent";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveLifecycleStage } from "@/lib/build-lifecycle";
import { buildLifecycleContext, lifecyclePillForCurrent } from "@/lib/build-lifecycle-context";
import LifecycleControls from "./LifecycleControls";
import LifecycleTimeline from "./LifecycleTimeline";
import BranchPosition from "./BranchPosition";
import BuildButton from "./BuildButton";
import AuthoringChat from "./AuthoringChat";
import PhaseList from "./PhaseList";
import BoxChip from "./BoxChip";
import RoadmapFilters from "./RoadmapFilters";
import { AgentTestedStamp, TestChip } from "../developer/spec-tests/SpecTestView";

// roadmap-board-renders-from-derived-getroadmap: the board reads EVERY spec signal from getRoadmap's
// derived SpecCard — `card.status` is the board status (phase rollup, plus the explicit in_review /
// deferred / folded overrides) and `card.phases` is the DB phase list with per-phase pr/merge_sha
// provenance. The retired `spec_card_state` mirror is no longer overlaid here — getRoadmap is the
// SOLE spec data source the board reads.

const COLUMNS: { key: SpecStatus; label: string }[] = [
  { key: "in_review", label: "In Review" },
  { key: "planned", label: "Planned" },
  { key: "in_progress", label: "In progress" },
  // "In testing" = built onto a per-build Vercel preview but BOTH the pre-merge spec-test green and
  // security green signals aren't yet true (preview-test-promote-pipeline M3 — `in_testing` derived
  // status). Only when BOTH are green AND the branch promotes (merges to main) does the card move on
  // to "Shipped". Cards with no preview + no merge stay in "In progress".
  { key: "in_testing", label: "In testing" },
  // "Shipped" = built + deployed but NOT yet owner-verified in prod. Verifying folds + archives the
  // spec, so this column stays a short, real to-do list. See docs/brain/project-management.md.
  { key: "shipped", label: "Shipped — awaiting verification" },
  // "Deferred" = parked work (a `**Deferred:**` marker / `**Status:** deferred`) — excluded by every
  // auto-build lane until the CEO un-defers it (director-drives-all-specs-and-deferred-status Phase 1).
  { key: "deferred", label: "Deferred" },
];

const DOT: Record<SpecStatus, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  in_testing: "bg-sky-500",
  in_review: "bg-slate-400",
  shipped: "bg-emerald-500",
  deferred: "bg-slate-400",
  rejected: "bg-rose-400",
};

const HEADER_ACCENT: Record<SpecStatus, string> = {
  planned: "text-zinc-500",
  in_progress: "text-amber-600",
  in_testing: "text-sky-600",
  in_review: "text-slate-500",
  shipped: "text-emerald-600",
  deferred: "text-slate-500",
  rejected: "text-rose-600",
};

/**
 * spec-review-agent Phase 4 — the In Review lane state chip. Renders the agent-pipeline state of a card
 * sitting in the In Review column so the CEO can see at a glance which step the spec is parked at:
 *
 *   - Vale pending           → still waiting on the CHECKLIST quality pass
 *   - Vale ✓ · Ada disposing → Vale cleared it; Ada's disposition lane will pick it up next
 *   - Ada → CEO upgrade      → Ada wants to upgrade a deferred suggestion to planned; CEO call queued
 *
 * The author's intended_status (a SUGGESTION, never binding) is rendered inline as "↳ planned/deferred"
 * so the CEO sees the proposal alongside the agent state. Rendered only on cards whose effective board
 * status is `in_review` (the column-only lane).
 */
function InReviewLane({ spec }: { spec: SpecCard }) {
  const intent = spec.intendedStatus ? ` ↳ ${spec.intendedStatus}` : "";
  let label: string;
  let title: string;
  let chip: string;
  if (spec.adaDisposition === "pending_upgrade") {
    label = `⬆ Ada → CEO upgrade${intent}`;
    title = "Ada wants to UPGRADE a deferred suggestion to planned — awaiting CEO Planned/Deferred call.";
    chip = "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
  } else if (spec.valePass === true) {
    label = `🔍✓ Vale passed · ⏳ Ada disposing${intent}`;
    title = "Vale cleared the CHECKLIST; Ada's disposition lane will pick it up next.";
    chip = "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300";
  } else if (spec.valePass === false) {
    // vale-instant-per-spec-review — Vale reviewed it and flagged needs_fix. Distinct from "pending" so a
    // failed review no longer looks unreviewed. The tooltip carries her latest diagnosis (+ defect count).
    const nDefects = spec.needsFixDefects?.length ?? 0;
    label = `🔍✗ Vale: needs fix${nDefects ? ` · ${nDefects} defect${nDefects === 1 ? "" : "s"}` : ""}${intent}`;
    title = spec.needsFixReason
      ? `Vale flagged this spec needs_fix — fix and re-send for re-review.\n\n${spec.needsFixReason}${
          spec.needsFixDefects?.length ? `\n\nDefects:\n• ${spec.needsFixDefects.join("\n• ")}` : ""
        }`
      : "Vale's CHECKLIST verdict is needs_fix — the spec is malformed and the build pipeline is hard-stopped behind it. Fix and re-send for re-review.";
    chip = "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300";
  } else {
    label = `🔍 Vale: pending review${intent}`;
    title = "Awaiting Vale's CHECKLIST quality pass — the build pipeline refuses this spec until it clears.";
    chip = "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
  }
  return (
    <div className="mt-1.5">
      <span
        title={title}
        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${chip}`}
      >
        {label}
      </span>
    </div>
  );
}

function CountPills({ counts }: { counts: SpecCard["counts"] }) {
  const all: { key: Phase; n: number }[] = [
    { key: "in_progress", n: counts.in_progress },
    { key: "planned", n: counts.planned },
    { key: "shipped", n: counts.shipped },
    { key: "rejected", n: counts.rejected },
  ];
  const items = all.filter((i) => i.n > 0);
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((i) => (
        <span
          key={i.key}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${DOT[i.key]}`} />
          {i.n}
        </span>
      ))}
    </div>
  );
}

// build-card-lifecycle-timeline Phase 2 — a folded spec's timeline reads ALL FIVE NODES CHECKED. The
// Archive section below the active board renders a tiny version of the timeline on every folded entry
// using this stable constant, so the verification "a folded spec → all 5 nodes checked" is visible.
const FOLDED_DERIVATION = deriveLifecycleStage({
  status: "folded",
  valePass: true,
  phases: [],
  builtOnBranch: true,
  buildLive: false,
  buildNeedsAttention: false,
  specTestVerdict: "approved",
  specTestHasOpenRegression: false,
  specTestLive: false,
  specTestHasChecks: true,
  securityLive: false,
  securitySurfaced: false,
  securityCompletedClean: true,
});

function Card({ spec, job, fold, testRun, humanResolved, status, goalSlugs, source, humanResolutions, liveSpecTestSlugs, security, folded }: { spec: SpecCard; job: AgentJob | null; fold: PendingFold | null; testRun: SpecTestRun | null; humanResolved?: number; status: SpecStatus; goalSlugs: string[]; source: SpecSource; humanResolutions: Map<string, import("@/lib/spec-test-runs").HumanCheckRow>; liveSpecTestSlugs: ReadonlySet<string>; security: SecurityStateBySlug | undefined; folded: boolean }) {
  // build-card-lifecycle-timeline Phase 2: the 5-node timeline replacing the floating pill on the card.
  // Derived from the same signals the board already loads (job / testRun / vale_pass / phases) plus the
  // per-board fetches for live spec-test jobs and the security-review rollup (one query each). The pill
  // label translates the LifecycleStageStatus + the live job into the same vocabulary the floating chip
  // used (so a CEO reading "Building…" / "Folding…" / "Vale pending" sees no copy regression).
  const lifecycleCtx = buildLifecycleContext({ spec, job, testRun, humanResolutions, liveSpecTestSlugs, security, folded });
  const derivation = deriveLifecycleStage(lifecycleCtx);
  const pill = lifecyclePillForCurrent(derivation, job, fold, lifecycleCtx.valePass);
  return (
    <div
      data-spec-search={`${spec.title} ${spec.slug} ${spec.owner || ""} ${spec.parent || ""} ${spec.summary || ""}`.toLowerCase()}
      data-status={status}
      data-goal={goalSlugs.join(" ")}
      data-source={source}
      className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <Link href={`/dashboard/roadmap/${spec.slug}`} className="group flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${DOT[spec.status]}`} />
        <h3 className="text-sm font-medium leading-snug text-zinc-900 group-hover:text-indigo-600 dark:text-zinc-100 dark:group-hover:text-indigo-400">
          {/* **Priority:** critical pip — surfaces SpecCard.critical so a human sees queue-first / gating specs
              at a glance (director-executable-plans-and-priority-board-pip Phase 1). */}
          {spec.critical && (
            <span
              className="mr-1.5 inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
              title="Priority: critical — queued first, can gate the build queue"
            >
              🔴 Critical
            </span>
          )}
          {spec.title}
        </h3>
      </Link>
      {/* spec-status-phase-pr-provenance Phase 3: one-shot specs (no phases) carry their shipping PR at
          the card level (specs.merged_pr → shippedPr on the derived SpecCard). Link to the PR so a shipped
          one-shot card is provable. Multi-phase specs surface per-phase PRs in PhaseList instead. */}
      {spec.status === "shipped" && spec.phases.length === 0 && spec.shippedPr && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <a
            href={`https://github.com/thecyclecoder/shopcx/pull/${spec.shippedPr}`}
            target="_blank"
            rel="noreferrer"
            title={`Shipped by PR #${spec.shippedPr}`}
            className="inline-flex items-center rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/30 dark:text-emerald-300 dark:hover:bg-emerald-950/50"
          >
            ✓ #{spec.shippedPr}
          </a>
        </div>
      )}
      {/* director-dismiss-park-and-short-circuit-spec Phase 2 — render a shipped card that was closed
          cleanly without all phases shipping ("we changed our mind") with a distinct sub-line so a
          reader doesn't think we actually built it. */}
      {spec.shortCircuited && (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300" title="Short-circuited: closed cleanly without all phases shipping.">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
          short-circuited{spec.shortCircuitReason ? ` — ${spec.shortCircuitReason}` : ""}
        </div>
      )}
      {spec.summary && (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{spec.summary}</p>
      )}
      {(spec.owner || spec.parent) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {spec.owner && (
            <Link
              href={`/dashboard/roadmap/functions/${spec.owner}`}
              className="inline-flex items-center rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:hover:bg-violet-900/50"
            >
              {spec.owner}
            </Link>
          )}
          {spec.parent && <span className="truncate text-[10px] text-zinc-400">↳ {spec.parent}</span>}
        </div>
      )}
      {/* spec-review-agent Phase 4 — the In Review column surface: which pipeline step the spec is parked
          at (Vale pending / Vale-passed-Ada-disposing / Ada-upgrade-awaiting-CEO) + the author's
          intended_status as a SUGGESTION the director reads but isn't bound by. */}
      {status === "in_review" && <InReviewLane spec={spec} />}
      {/* spec-goal-branch-pm-flow M6 — the branch-flow timeline: built on branch → in testing → on goal
          branch (goal-bound only) → promoted to main. Makes the in_testing state legible as "tested on a
          branch, not in prod" instead of conflated with shipped. goalBound drops the goal-branch step for a
          one-off spec (it promotes straight to main). */}
      <BranchPosition spec={spec} goalBound={goalSlugs.length > 0} />
      <CountPills counts={spec.counts} />
      {/* Spec-test agent stamp + chip on a shipped-awaiting-verification card (spec-test-agent). */}
      {spec.status === "shipped" && testRun && (
        <Link href="/dashboard/developer/spec-tests" className="mt-2 flex flex-wrap items-center gap-2 hover:opacity-80">
          <AgentTestedStamp verdict={testRun.agent_verdict} />
          <TestChip summary={testRun.summary} humanResolved={humanResolved} />
        </Link>
      )}
      {spec.phases.length > 0 && <PhaseList slug={spec.slug} phases={spec.phases} />}
      {/* build-card-lifecycle-timeline Phase 2 — the 5-node lifecycle timeline replacing the floating
          pill. Renders Spec Review · Build · Spec Test · Security · Fold; the live status pill attaches
          to the CURRENT (earliest non-done) stage rather than floating in the action row. */}
      <LifecycleTimeline derivation={derivation} currentLabel={pill.label} currentTitle={pill.title} />
      <div className="mt-2 space-y-2">
        {/* Status is DERIVED (getRoadmap rolls up spec_phases) and never user-settable — the only real
            board inputs are the explicit-lifecycle levers: Review / Prioritize / Defer / Make Active. */}
        <LifecycleControls slug={spec.slug} status={spec.status} critical={spec.critical} />
        <BuildButton slug={spec.slug} initialJob={job} specStatus={spec.status} initialFold={fold} blockedBy={spec.blockedBy} />
      </div>
      {/* The per-spec markdown is deleted (db-driven-specs) — link to the DB-backed spec detail route
          instead of a dead `specs/{slug}.md` file path. */}
      <div className="mt-1.5 text-[11px] text-zinc-400">
        <Link href={`/dashboard/roadmap/${spec.slug}`} className="font-mono hover:text-indigo-600 dark:hover:text-indigo-400">
          {spec.slug}
        </Link>
      </div>
    </div>
  );
}

export default async function RoadmapPage() {
  const workspaceId = await getActiveWorkspaceId();
  // getRoadmap(workspaceId) returns SpecCard[] with status DERIVED from spec_phases (the phase rollup
  // plus the explicit in_review / deferred overrides) and card.phases straight from the DB row with
  // per-phase pr/merge_sha provenance — the SOLE spec data source the board reads. No spec_card_state.
  const [{ specs }, archive, filters] = await Promise.all([
    getRoadmap(workspaceId ?? undefined),
    // spec-fold-from-db-row Phase 2: pass the workspaceId so getArchive() reads folded specs from
    // public.specs directly (the row is preserved at fold time, status='folded'). Falls back to the
    // filesystem when no workspace is in scope.
    getArchive(workspaceId ?? undefined),
    getRoadmapFilters(workspaceId ?? undefined),
  ]);
  // build-card-lifecycle-timeline Phase 2 — additional per-board fetches the lifecycle timeline reads:
  //   - humanResolutions (the spec_test_human_checks rows) — for the open-regression flag on Spec Test
  //   - liveSpecTestSlugs (active spec-test agent_jobs) — for Spec Test = active vs done
  //   - securityBySlug (security-review agent_jobs rollup) — for the Security node (and Phase 3 gate)
  //   - foldedSet (specs.status='folded') — the SpecCard surface coerces folded→shipped, so the timeline
  //     reads the raw flag from the archive snapshot to mark the Fold node done.
  const [jobsBySlug, folds, testRuns, humanResolvedBySlug, humanResolutions, liveSpecTestSlugs, securityBySlug] = workspaceId
    ? await Promise.all([
        getLatestJobsBySlug(workspaceId),
        getPendingFolds(workspaceId),
        getLatestSpecTestRuns(workspaceId),
        getHumanResolutionCounts(workspaceId),
        getHumanCheckResolutions(workspaceId),
        getLiveSpecTestSlugs(workspaceId),
        getSecurityStateBySlug(createAdminClient(), workspaceId),
      ])
    : [
        {} as Record<string, AgentJob>,
        {} as Record<string, PendingFold>,
        {} as Record<string, SpecTestRun>,
        {} as Record<string, number>,
        new Map<string, import("@/lib/spec-test-runs").HumanCheckRow>(),
        new Set<string>() as ReadonlySet<string>,
        {} as Record<string, SecurityStateBySlug>,
      ];
  if (workspaceId) await reconcileMergedJobs(Object.values(jobsBySlug));
  // `getRoadmap` already filters folded specs out (boardable-only), so every card on the active board is
  // `folded: false`. The Archive section below renders a separate compact timeline that synthesizes a
  // folded LifecycleContext from a stable constant (the spec's slug isn't tracked through archive entries).
  // Column placement = the DERIVED `card.status` from getRoadmap, with ONE live-build overlay: a card
  // that derives `planned` but has an active build job in flight is promoted to In progress (never
  // demotes a further-along status). The job overlay reads agent_jobs, not spec_card_state.
  const effectiveStatus = (sp: SpecCard): SpecStatus => {
    const job = jobsBySlug[sp.slug];
    if (sp.status === "planned" && job && isActive(job.status)) return "in_progress";
    return sp.status;
  };
  const byStatus = (s: SpecStatus) => specs.filter((sp) => effectiveStatus(sp) === s);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Pipeline</h1>
        <div className="flex items-center gap-3">
          <BoxChip />
          <Link href="/dashboard/roadmap/goals" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Goals →
          </Link>
          <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Map view →
          </Link>
          <AuthoringChat seed triggerLabel="🧠 New spec from brain" />
          <AuthoringChat triggerLabel="✨ New feature" />
        </div>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Live view of <code>public.specs</code> — the DB row is the source of truth, so this never drifts.
        Each card&apos;s column is the status <span className="font-medium">derived from its phases</span> (planned · in progress · shipped),
        plus the explicit in&nbsp;review / deferred lifecycle states.
      </p>

      <RoadmapFilters goals={filters.goals} />

      {specs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No specs found in <code>public.specs</code>.
        </div>
      ) : (
        /* roadmap-board-horizontal-scroll: all 6 status columns live in ONE non-wrapping flex row that
           scrolls horizontally. Mobile shows ~1 column (basis-[86%] leaves a peek of the next); md+ fits
           exactly 3 columns to the viewport via basis calc((100% - 2*gap)/3) (gap-4 = 1rem). The
           .scrollbar-hidden utility (globals.css) hides the bar for an app-like feel — scoped to THIS
           container only. scroll-snap keeps columns aligned on flick. Vertical card stacking/scroll
           stays WITHIN each column (the inner space-y-3 list) unchanged. */
        <div className="scrollbar-hidden flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const items = byStatus(col.key);
            return (
              <div
                key={col.key}
                className="min-w-0 flex-shrink-0 snap-start basis-[86%] md:basis-[calc((100%-2rem)/3)]"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${DOT[col.key]}`} />
                  <h2 className={`text-xs font-semibold uppercase tracking-wide ${HEADER_ACCENT[col.key]}`}>{col.label}</h2>
                  <span className="text-xs tabular-nums text-zinc-400">{items.length}</span>
                </div>
                <div className="space-y-3">
                  {items.length === 0 ? (
                    <div data-empty-placeholder className="rounded-lg border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
                      Nothing here
                    </div>
                  ) : (
                    items.map((spec) => <Card key={spec.slug} spec={spec} job={jobsBySlug[spec.slug] ?? null} fold={folds[spec.slug] ?? null} testRun={testRuns[spec.slug] ?? null} humanResolved={humanResolvedBySlug[spec.slug] ?? 0} status={col.key} goalSlugs={filters.goalsBySpec[spec.slug] ?? []} source={filters.sourceBySpec[spec.slug] ?? "manual"} humanResolutions={humanResolutions} liveSpecTestSlugs={liveSpecTestSlugs} security={securityBySlug[spec.slug]} folded={false} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {archive.length > 0 && (
        <details id="roadmap-archive" className="mt-6 rounded-lg border border-zinc-200 bg-white/60 dark:border-zinc-800 dark:bg-zinc-900/40">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 marker:text-zinc-400 dark:text-zinc-400">
            Archived — verified &amp; retired
            <span className="ml-2 tabular-nums text-zinc-400">{archive.length}</span>
          </summary>
          <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <p className="mb-3 text-xs text-zinc-400">
              Shipped + owner-verified in production, folded into the brain. Reads the folded{" "}
              <code>public.specs</code> rows (status=&apos;folded&apos;). Re-hydrate any of these into a fresh spec.
            </p>
            <ul className="space-y-2">
              {archive.map((e, i) => (
                <li key={i} data-spec-search={`${e.title} ${e.link} ${e.label}`.toLowerCase()} className="flex flex-col gap-1 rounded-md px-1 py-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" />
                    <Link href={`/dashboard/brain/${e.link}`} className="font-medium text-zinc-700 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400">
                      {e.title}
                    </Link>
                    {e.date && <span className="text-zinc-400">verified {e.date}</span>}
                    <span className="text-zinc-300 dark:text-zinc-600">·</span>
                    <Link href={`/dashboard/brain/${e.link}`} className="text-teal-600 hover:underline dark:text-teal-400">
                      {e.label} ↗
                    </Link>
                    <AuthoringChat seed seedSlug={e.link} triggerLabel="New spec from brain" />
                  </div>
                  {/* build-card-lifecycle-timeline Phase 2 — a folded spec's timeline reads all 5 nodes
                      checked. Rendered in a compact density so it stays unobtrusive in the archive list. */}
                  <div className="ml-3.5 max-w-md">
                    <LifecycleTimeline derivation={FOLDED_DERIVATION} density="compact" />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}
