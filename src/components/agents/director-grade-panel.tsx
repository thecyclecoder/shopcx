"use client";

import { useEffect, useState } from "react";

// Director grade scorecard (parity with AgentGradePanel) — on the director's profile, the CEO's view of
// HER calls: an overall rollup + per-dimension averages (auto-approval / goal-escort) + recent graded
// calls. Same shape as an agent's rollup card, one level up. Fetches the director grade report
// (/api/developer/agents/grades). So the grade rollup lives on the profile, not only in a separate tab.

interface DimensionStat {
  dimension: string;
  graded: number;
  avgGrade: number | null;
  trend: "up" | "down" | "flat" | null;
}
interface GradeRow {
  id: string;
  dimension: string;
  grade: number | null;
  reasoning: string | null;
  target_label: string;
  graded_by: string;
  created_at: string;
}
interface Report {
  dimensions: DimensionStat[];
  rows: GradeRow[];
}

function timeAgo(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function gradeColor(n: number): string {
  if (n >= 8) return "text-green-600 dark:text-green-400";
  if (n >= 7) return "text-zinc-700 dark:text-zinc-200";
  if (n >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}
function gradeChipCls(grade: number): string {
  return grade >= 8
    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
    : grade >= 7
      ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
      : grade >= 5
        ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
}
function Trend({ trend }: { trend: DimensionStat["trend"] }) {
  if (trend === "up") return <span className="text-green-600 dark:text-green-400">▲ improving</span>;
  if (trend === "down") return <span className="text-amber-600 dark:text-amber-400">▼ slipping</span>;
  if (trend === "flat") return <span className="text-zinc-400">steady</span>;
  return <span className="text-zinc-300">—</span>;
}

export function DirectorGradePanel() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/developer/agents/grades")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive) {
            setReport(d);
            setLoading(false);
          }
        })
        .catch(() => alive && setLoading(false));
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (loading) return <p className="text-[12px] text-zinc-400">Loading grades…</p>;
  if (!report) return <p className="text-[12px] text-zinc-400">Couldn&apos;t load grades.</p>;

  const dims = report.dimensions ?? [];
  const totalGraded = dims.reduce((s, d) => s + d.graded, 0);
  const overall = totalGraded ? dims.reduce((s, d) => s + (d.avgGrade ?? 0) * d.graded, 0) / totalGraded : null;
  const recent = (report.rows ?? []).slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Rollup tiles — overall + per dimension (the CEO grades her calls). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className={`text-2xl font-semibold ${overall != null ? gradeColor(overall) : "text-zinc-300"}`}>
            {overall != null ? overall.toFixed(1) : "—"}
            <span className="text-sm font-normal text-zinc-400">/10</span>
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-400">overall · {totalGraded} call{totalGraded === 1 ? "" : "s"}</div>
        </div>
        {dims.map((d) => (
          <div key={d.dimension} className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className={`text-2xl font-semibold ${d.avgGrade != null ? gradeColor(d.avgGrade) : "text-zinc-300"}`}>
              {d.avgGrade != null ? d.avgGrade.toFixed(1) : "—"}
              <span className="text-sm font-normal text-zinc-400">/10</span>
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-400">
              {d.dimension} · {d.graded} · <Trend trend={d.trend} />
            </div>
          </div>
        ))}
      </div>

      {/* Recent graded calls. */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Recent calls</h3>
        {!recent.length ? (
          <p className="text-[12px] text-zinc-400">No graded calls yet — they appear here as the CEO grades her decisions.</p>
        ) : (
          <ol className="space-y-1.5">
            {recent.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-[12px]">
                <span className="mt-0.5 whitespace-nowrap text-zinc-400">{timeAgo(r.created_at)}</span>
                <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${r.grade != null ? gradeChipCls(r.grade) : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                  {r.grade != null ? `${r.grade}/10` : "—"}
                  {r.graded_by === "human" ? " ✎" : ""}
                </span>
                <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
                  <span className="font-mono text-[11px] text-zinc-500">{r.target_label}</span>
                  {r.reasoning && <span className="block text-zinc-500 dark:text-zinc-400">{r.reasoning}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
