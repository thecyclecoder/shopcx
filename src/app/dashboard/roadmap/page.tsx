import Link from "next/link";
import { getRoadmap, type Phase, type SpecCard } from "@/lib/brain-roadmap";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getLatestJobsBySlug, type AgentJob } from "@/lib/agent-jobs";
import StatusControl from "./StatusControl";
import BuildButton from "./BuildButton";
import AuthoringChat from "./AuthoringChat";
import PhaseList from "./PhaseList";

// The board reads docs/brain/specs at request time — always reflect the live brain.
export const dynamic = "force-dynamic";

const COLUMNS: { key: Phase; label: string }[] = [
  { key: "planned", label: "Planned" },
  { key: "in_progress", label: "In progress" },
  { key: "shipped", label: "Shipped" },
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

function Card({ spec, job }: { spec: SpecCard; job: AgentJob | null }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
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
            <span className="inline-flex items-center rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
              {spec.owner}
            </span>
          )}
          {spec.parent && <span className="truncate text-[10px] text-zinc-400">↳ {spec.parent}</span>}
        </div>
      )}
      <CountPills counts={spec.counts} />
      {spec.phases.length > 0 && <PhaseList slug={spec.slug} phases={spec.phases} />}
      <div className="mt-2 flex items-center justify-between gap-2">
        <StatusControl slug={spec.slug} status={spec.status} />
        <BuildButton slug={spec.slug} initialJob={job} specStatus={spec.status} />
      </div>
      <div className="mt-1.5 text-[11px] text-zinc-400">
        <code>specs/{spec.slug}.md</code>
      </div>
    </div>
  );
}

export default async function RoadmapPage() {
  const { specs, tracks } = await getRoadmap();
  const workspaceId = await getActiveWorkspaceId();
  const jobsBySlug = workspaceId ? await getLatestJobsBySlug(workspaceId) : {};
  const byStatus = (s: Phase) => specs.filter((sp) => sp.status === s);

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Roadmap</h1>
        <div className="flex items-center gap-3">
          <Link href="/dashboard/roadmap/map" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            Map view →
          </Link>
          <AuthoringChat triggerLabel="✨ New feature" />
        </div>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Live view of <code>docs/brain/specs/</code> — the markdown is the source of truth, so this never drifts.
        Status comes from the <span className="font-medium">⏳ planned · 🚧 in progress · ✅ shipped</span> phase emojis.
      </p>

      {tracks.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-2">
          {tracks.map((t, i) => (
            <span
              key={i}
              title={t.why}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${DOT[t.status]}`} />
              {t.title}
            </span>
          ))}
        </div>
      )}

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
                    <div className="rounded-lg border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
                      Nothing here
                    </div>
                  ) : (
                    items.map((spec) => <Card key={spec.slug} spec={spec} job={jobsBySlug[spec.slug] ?? null} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
