"use client";

import { useEffect, useState } from "react";

// Director activity feed (director observability) — the director's own `director_activity` rows,
// shown on its profile page (/dashboard/agents/[role]). A live, visible record that the director is
// alive and exactly what it's doing autonomously: each row is an action it took (auto-approved an
// error fix, escorted a goal/spec, coached a worker, escalated to the CEO) with its reason + time.

interface ActivityEntry {
  id: string;
  actionKind: string;
  specSlug: string | null;
  reason: string | null;
  createdAt: string;
  // director-dismiss-park-and-short-circuit-spec Phase 1 — present on a `dismissed_park` row so the CEO
  // can Re-open the parked job in one tap (cleared once a `reopened_park` row for the same job lands).
  jobId?: string | null;
  reopenable?: boolean;
}

function actionChip(kind: string): { label: string; cls: string } {
  const k = kind.toLowerCase();
  if (k.includes("escalat")) return { label: "escalated to CEO", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" };
  if (k.includes("approve")) return { label: "auto-approved", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" };
  if (k.includes("escorted_fix") || k.includes("queued_fix")) return { label: "queued fix build", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" };
  if (k.includes("escort")) return { label: "escorted", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" };
  if (k.includes("coach")) return { label: "coached agent", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" };
  if (k === "dismissed_park") return { label: "dismissed park", cls: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" };
  if (k === "reopened_park") return { label: "re-opened park", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" };
  return { label: kind.replace(/_/g, " "), cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" };
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const m = Math.round((now - then) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DirectorActivity({ fn }: { fn: string }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const load = (alive = true) =>
    fetch(`/api/developer/agents/activity?fn=${encodeURIComponent(fn)}`)
      .then((r) => (r.ok ? r.json() : { activity: [] }))
      .then((d) => {
        if (alive) {
          setEntries(d.activity || []);
          setLoading(false);
        }
      })
      .catch(() => alive && setLoading(false));

  useEffect(() => {
    let alive = true;
    load(alive);
    const t = setInterval(() => load(alive), 30000); // live: refresh every 30s
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fn]);

  const reopenPark = async (jobId: string) => {
    setBusyJobId(jobId);
    try {
      const res = await fetch("/api/developer/director-activity/reopen-park", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Re-open failed: ${body.error || res.statusText}`);
      } else {
        await load(true);
      }
    } finally {
      setBusyJobId(null);
    }
  };

  if (loading) return <p className="text-[12px] text-zinc-400">Loading activity…</p>;
  if (!entries.length)
    return <p className="text-[12px] text-zinc-400">No activity yet — actions appear here the moment she takes them.</p>;

  return (
    <ol className="space-y-1.5">
      {entries.map((e) => {
        const chip = actionChip(e.actionKind);
        const canReopen = !!e.reopenable && !!e.jobId;
        return (
          <li key={e.id} className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5 whitespace-nowrap text-zinc-400">{timeAgo(e.createdAt)}</span>
            <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}>{chip.label}</span>
            <span className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">
              {e.specSlug && <span className="font-mono text-[11px] text-zinc-500">{e.specSlug}</span>}
              {e.reason && <span className="block text-zinc-500 dark:text-zinc-400">{e.reason}</span>}
            </span>
            {canReopen && (
              <button
                type="button"
                onClick={() => e.jobId && reopenPark(e.jobId)}
                disabled={busyJobId === e.jobId}
                className="mt-0.5 shrink-0 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                title="Re-open this dismissed park — restores it to needs_attention and clears the dismissal marker."
              >
                {busyJobId === e.jobId ? "…" : "Re-open"}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
