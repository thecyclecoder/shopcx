import Link from "next/link";
import { getRoadmap, getArchive, getRoadmapFilters, type Phase, type SpecCard, type SpecSource } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug, getPendingFolds, reconcileMergedJobs, isActive, type AgentJob, type PendingFold } from "@/lib/agent-jobs";
import { getLatestSpecTestRuns, getHumanResolutionCounts, type SpecTestRun } from "@/lib/spec-test-runs";
import StatusControl from "./StatusControl";
import BuildButton from "./BuildButton";
import AuthoringChat from "./AuthoringChat";
import PhaseList from "./PhaseList";
import BoxChip from "./BoxChip";
import RoadmapFilters from "./RoadmapFilters";
import { AgentTestedStamp, TestChip } from "../developer/spec-tests/SpecTestView";

// The board reads docs/brain/specs at request time — always reflect the live brain.
export const dynamic = "force-dynamic";

const COLUMNS: { key: Phase; label: string }[] = [
  { key: "planned", label: "Planned" },
  { key: "in_progress", label: "In progress" },
  // "Shipped" = built + deployed but NOT yet owner-verified in prod. Verifying folds + archives the
  // spec, so this column stays a short, real to-do list. See docs/brain/project-management.md.
  { key: "shipped", label: "Shipped — awaiting verification" },
];

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};

const HEADER_ACCENT: Record<Phase, string> = {
  planned: "text-zinc-500",
  in_progress: "text-amber-600",
  shipped: "text-emerald-600",
  rejected: "text-rose-600",
};

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

function Card({ spec, job, fold, testRun, humanResolved, status, goalSlugs, source }: { spec: SpecCard; job: AgentJob | null; fold: PendingFold | null; testRun: SpecTestRun | null; humanResolved?: number; status: Phase; goalSlugs: string[]; source: SpecSource }) {
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
          {spec.title}
        </h3>
      </Link>
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
      <CountPills counts={spec.counts} />
      {/* Spec-test agent stamp + chip on a shipped-awaiting-verification card (spec-test-agent). */}
      {spec.status === "shipped" && testRun && (
        <Link href="/dashboard/developer/spec-tests" className="mt-2 flex flex-wrap items-center gap-2 hover:opacity-80">
          <AgentTestedStamp verdict={testRun.agent_verdict} />
          <TestChip summary={testRun.summary} humanResolved={humanResolved} />
        </Link>
      )}
      {spec.phases.length > 0 && <PhaseList slug={spec.slug} phases={spec.phases} />}
      <div className="mt-2 space-y-2">
        <StatusControl slug={spec.slug} status={spec.status} />
        <BuildButton slug={spec.slug} initialJob={job} specStatus={spec.status} initialFold={fold} blockedBy={spec.blockedBy} />
      </div>
      <div className="mt-1.5 text-[11px] text-zinc-400">
        <code>specs/{spec.slug}.md</code>
      </div>
    </div>
  );
}

export default async function RoadmapPage() {
  const [{ specs }, archive, filters] = await Promise.all([getRoadmap(), getArchive(), getRoadmapFilters()]);
  const workspaceId = await getActiveWorkspaceId();
  const [jobsBySlug, folds, testRuns, humanResolvedBySlug] = workspaceId
    ? await Promise.all([getLatestJobsBySlug(workspaceId), getPendingFolds(workspaceId), getLatestSpecTestRuns(workspaceId), getHumanResolutionCounts(workspaceId)])
    : [{} as Record<string, AgentJob>, {} as Record<string, PendingFold>, {} as Record<string, SpecTestRun>, {} as Record<string, number>];
  if (workspaceId) await reconcileMergedJobs(Object.values(jobsBySlug));
  // Live overlay: a Planned spec with an active build job shows as In progress immediately (tapping Build
  // inserts the job, so the card jumps columns within one render), reverting to its markdown status once
  // the job is terminal. Only ever *promotes* planned→in_progress — never demotes a Shipped spec.
  const effectiveStatus = (sp: SpecCard): Phase => {
    const job = jobsBySlug[sp.slug];
    if (sp.status === "planned" && job && isActive(job.status)) return "in_progress";
    return sp.status;
  };
  const byStatus = (s: Phase) => specs.filter((sp) => effectiveStatus(sp) === s);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Roadmap</h1>
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
        Live view of <code>docs/brain/specs/</code> — the markdown is the source of truth, so this never drifts.
        Status comes from the <span className="font-medium">⏳ planned · 🚧 in progress · ✅ shipped</span> phase emojis.
      </p>

      <RoadmapFilters goals={filters.goals} />

      {specs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No specs found in <code>docs/brain/specs/</code>.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const items = byStatus(col.key);
            return (
              <div key={col.key} className="min-w-0">
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
                    items.map((spec) => <Card key={spec.slug} spec={spec} job={jobsBySlug[spec.slug] ?? null} fold={folds[spec.slug] ?? null} testRun={testRuns[spec.slug] ?? null} humanResolved={humanResolvedBySlug[spec.slug] ?? 0} status={col.key} goalSlugs={filters.goalsBySpec[spec.slug] ?? []} source={filters.sourceBySpec[spec.slug] ?? "manual"} />)
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
              Shipped + owner-verified in production, folded into the brain, and removed from{" "}
              <code>specs/</code>. Reads <code>docs/brain/archive.md</code>. Re-hydrate any of these into a fresh spec.
            </p>
            <ul className="space-y-1.5">
              {archive.map((e, i) => (
                <li key={i} data-spec-search={`${e.title} ${e.link} ${e.label}`.toLowerCase()} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}
