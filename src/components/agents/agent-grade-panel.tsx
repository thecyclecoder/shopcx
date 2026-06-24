"use client";

import { useEffect, useState } from "react";

// Worker observability (worker-grading-and-director-management Phase 3) — on a worker's profile page
// (/dashboard/agents/[role]) the Director's view of this worker: a rollup-grade card (last-10 average +
// trend, the signal she coaches on) + a live feed of its recently-CONCLUDED agent_jobs, each with the
// grade she gave it. One fetch of /api/developer/agents/agent-grades?kind=… backs both.

interface RecentAction {
  id: string;
  specSlug: string | null;
  status: string;
  prUrl: string | null;
  createdAt: string;
  grade: number | null;
  reasoning: string | null;
  gradedBy: string | null;
}
interface Rollup {
  agentKind: string;
  count: number;
  average: number | null;
  priorAverage: number | null;
  drop: number | null;
}
interface Payload {
  kind: string;
  rubric: string | null;
  rollup: Rollup;
  recent: RecentAction[];
}

function timeAgo(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Grade → tile color (a slip is amber/red, a strong score green). */
function gradeColor(n: number): string {
  if (n >= 8) return "text-green-600 dark:text-green-400";
  if (n >= 7) return "text-zinc-700 dark:text-zinc-200";
  if (n >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function gradeChip(grade: number | null, status: string): { label: string; cls: string } {
  if (grade != null) {
    const cls =
      grade >= 8
        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
        : grade >= 7
          ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          : grade >= 5
            ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
            : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    return { label: `${grade}/10`, cls };
  }
  if (status === "failed" || status === "needs_attention")
    return { label: "ungraded · failed", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
  return { label: "ungraded", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
}

function Trend({ drop }: { drop: number | null }) {
  if (drop == null) return null;
  if (drop > 1.5) return <span className="text-red-600 dark:text-red-400">▼ {drop.toFixed(1)} — coaching triggered</span>;
  if (drop > 0.3) return <span className="text-amber-600 dark:text-amber-400">▼ {drop.toFixed(1)}</span>;
  if (drop < -0.3) return <span className="text-green-600 dark:text-green-400">▲ {Math.abs(drop).toFixed(1)}</span>;
  return <span className="text-zinc-400">steady</span>;
}

export function AgentGradePanel({ kind }: { kind: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/developer/agents/agent-grades?kind=${encodeURIComponent(kind)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive) {
            setData(d);
            setLoading(false);
          }
        })
        .catch(() => alive && setLoading(false));
    load();
    const t = setInterval(load, 30000); // live: refresh every 30s
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [kind]);

  if (loading) return <p className="text-[12px] text-zinc-400">Loading grades…</p>;
  if (!data) return <p className="text-[12px] text-zinc-400">Couldn&apos;t load grades.</p>;

  const { rollup, recent } = data;
  const avg = rollup.average;

  return (
    <div className="space-y-6">
      {/* Rollup-grade card — last-10 average + trend (the signal the Director coaches on). */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className={`text-2xl font-semibold ${avg != null ? gradeColor(avg) : "text-zinc-300"}`}>
            {avg != null ? avg.toFixed(1) : "—"}
            <span className="text-sm font-normal text-zinc-400">/10</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">last-{rollup.count || 0} avg</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-2xl font-semibold text-zinc-700 dark:text-zinc-200">{rollup.count}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">graded actions</div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="text-[13px] font-medium">
            <Trend drop={rollup.drop} />
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">trend vs prior 10</div>
        </div>
      </div>

      {/* The graded actions — each concluded job + the grade she gave it. */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Recent actions</h3>
        {!recent.length ? (
          <p className="text-[12px] text-zinc-400">No concluded actions yet — they appear here with their grade as the worker runs.</p>
        ) : (
          <ol className="space-y-1.5">
            {recent.map((a) => {
              const chip = gradeChip(a.grade, a.status);
              return (
                <li key={a.id} className="flex items-start gap-2 text-[12px]">
                  <span className="mt-0.5 whitespace-nowrap text-zinc-400">{timeAgo(a.createdAt)}</span>
                  <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}>{chip.label}</span>
                  <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
                    {a.specSlug && <span className="font-mono text-[11px] text-zinc-500">{a.specSlug}</span>}
                    {a.reasoning && <span className="block text-zinc-500 dark:text-zinc-400">{a.reasoning}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
