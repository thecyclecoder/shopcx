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
}

function actionChip(kind: string): { label: string; cls: string } {
  const k = kind.toLowerCase();
  if (k.includes("escalat")) return { label: "escalated to CEO", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" };
  if (k.includes("approve")) return { label: "auto-approved", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" };
  if (k.includes("escorted_fix") || k.includes("queued_fix")) return { label: "queued fix build", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" };
  if (k.includes("escort")) return { label: "escorted", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" };
  if (k.includes("coach")) return { label: "coached worker", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" };
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

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/developer/agents/activity?fn=${encodeURIComponent(fn)}`)
        .then((r) => (r.ok ? r.json() : { activity: [] }))
        .then((d) => {
          if (alive) {
            setEntries(d.activity || []);
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
  }, [fn]);

  if (loading) return <p className="text-[12px] text-zinc-400">Loading activity…</p>;
  if (!entries.length)
    return <p className="text-[12px] text-zinc-400">No activity yet — actions appear here the moment she takes them.</p>;

  return (
    <ol className="space-y-1.5">
      {entries.map((e) => {
        const chip = actionChip(e.actionKind);
        return (
          <li key={e.id} className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5 whitespace-nowrap text-zinc-400">{timeAgo(e.createdAt)}</span>
            <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}>{chip.label}</span>
            <span className="min-w-0 text-zinc-700 dark:text-zinc-300">
              {e.specSlug && <span className="font-mono text-[11px] text-zinc-500">{e.specSlug}</span>}
              {e.reason && <span className="block text-zinc-500 dark:text-zinc-400">{e.reason}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
