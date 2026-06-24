"use client";

import { useEffect, useState } from "react";
import { getPersona } from "@/lib/agents/personas";

// Worker coaching history (worker-coaching-loop spec, Phase 1) — the director→worker messages a worker
// has received over time, shown on its profile page (/dashboard/agents/[role]). A real, visible record
// of how the director has been teaching this worker: each row is the triggering pattern + the old→new
// instruction diff + the attempt count + the post-coaching re-check verdict (did the learning stick?).

interface CoachingEntry {
  id: string;
  workerKind: string;
  coachedBy: string;
  errorClass: string;
  triggeringPattern: string;
  oldInstruction: string | null;
  newInstruction: string;
  reasoning: string;
  attempt: number;
  kind: string;
  recheckStatus: string;
  createdAt: string;
}

function recheckChip(status: string): { label: string; cls: string } {
  if (status === "stuck") return { label: "learning stuck", cls: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" };
  if (status === "recurred") return { label: "recurred — re-coaching", cls: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" };
  return { label: "checking…", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" };
}

function kindLabel(kind: string): string {
  if (kind === "code-bug-route") return "routed to Repair";
  if (kind === "escalation") return "escalated to CEO";
  return "coached";
}

export function WorkerCoachingHistory({ kind }: { kind: string }) {
  const [entries, setEntries] = useState<CoachingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    fetch(`/api/developer/agents/coaching?kind=${encodeURIComponent(kind)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { history: CoachingEntry[] }) => {
        if (live) setEntries(d.history ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [kind]);

  if (loading) {
    return <p className="mt-2 text-[12px] text-zinc-400">Loading coaching history…</p>;
  }
  if (!entries.length) {
    return <p className="mt-2 text-[12px] text-zinc-400">No coaching yet — the director hasn&apos;t needed to teach this agent.</p>;
  }

  return (
    <ul className="mt-2 space-y-2">
      {entries.map((e) => {
        const dp = getPersona(e.coachedBy);
        const chip = recheckChip(e.recheckStatus);
        return (
          <li key={e.id} className="rounded-lg border border-zinc-200 bg-white px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                {dp.emoji} {dp.name} {kindLabel(e.kind)}
              </span>
              <span className="font-mono text-[10px] text-zinc-400">{e.errorClass}</span>
              <span className="text-zinc-400">· attempt {e.attempt}</span>
              {e.kind === "coaching" && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${chip.cls}`}>{chip.label}</span>
              )}
              <span className="ml-auto text-[10px] text-zinc-400">{new Date(e.createdAt).toLocaleDateString()}</span>
            </div>
            {e.triggeringPattern && <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">{e.triggeringPattern}</p>}
            <p className="mt-1 text-sm text-zinc-800 dark:text-zinc-200">{e.newInstruction}</p>
            {e.oldInstruction && (
              <p className="mt-1 text-[11px] text-zinc-400 line-through">was: {e.oldInstruction}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
