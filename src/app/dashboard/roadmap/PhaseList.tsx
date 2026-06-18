"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { Phase, SpecPhase } from "@/lib/brain-roadmap";

const DOT: Record<Phase, string> = {
  planned: "bg-zinc-400",
  in_progress: "bg-amber-500",
  shipped: "bg-emerald-500",
  rejected: "bg-rose-400",
};
const ORDER: Phase[] = ["planned", "in_progress", "shipped", "rejected"];
const LABEL: Record<Phase, string> = { planned: "Planned", in_progress: "In progress", shipped: "Shipped", rejected: "Cut" };

/**
 * Collapsible phase list. Owners can set each phase's status (commits the phase emoji to the
 * brain) and queue a build scoped to just that phase. Read-only dots for everyone else.
 */
export default function PhaseList({ slug, phases }: { slug: string; phases: SpecPhase[] }) {
  const workspace = useWorkspace();
  const isOwner = workspace.role === "owner";
  const [statuses, setStatuses] = useState<Phase[]>(phases.map((p) => p.status));
  const [building, setBuilding] = useState<number | null>(null);
  const [builtMsg, setBuiltMsg] = useState<number | null>(null);

  async function setStatus(i: number, s: Phase) {
    if (statuses[i] === s) return;
    const prev = statuses[i];
    setStatuses((arr) => arr.map((v, j) => (j === i ? s : v)));
    try {
      const res = await fetch("/api/roadmap/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, phaseIndex: i, status: s }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setStatuses((arr) => arr.map((v, j) => (j === i ? prev : v)));
    }
  }

  async function buildPhase(i: number) {
    if (building !== null) return;
    setBuilding(i);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          instructions: `Implement ONLY this phase of the spec: "${phases[i].title}". Mark that phase's emoji ✅ when done. Do not modify other phases.`,
        }),
      });
      if (res.ok) {
        setBuiltMsg(i);
        setTimeout(() => setBuiltMsg(null), 4000);
      }
    } finally {
      setBuilding(null);
    }
  }

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer list-none text-[11px] font-medium text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
        <span className="inline-block transition-transform group-open:rotate-90">▸</span> {phases.length} phases
      </summary>
      <ul className="mt-1.5 space-y-1.5 border-l border-zinc-100 pl-3 dark:border-zinc-800">
        {phases.map((p, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            {isOwner ? (
              <span className="mt-0.5 inline-flex flex-shrink-0 gap-0.5">
                {ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    title={LABEL[s]}
                    onClick={() => setStatus(i, s)}
                    className={`h-2.5 w-2.5 rounded-full border ${
                      statuses[i] === s ? `${DOT[s]} border-transparent` : "border-zinc-300 bg-transparent dark:border-zinc-600"
                    }`}
                  />
                ))}
              </span>
            ) : (
              <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[statuses[i]]}`} />
            )}
            <span className={`flex-1 ${statuses[i] === "rejected" ? "text-zinc-400 line-through" : ""}`}>{p.title}</span>
            {isOwner && statuses[i] !== "rejected" && (
              <button
                type="button"
                onClick={() => buildPhase(i)}
                disabled={building !== null}
                title="Build just this phase"
                className="flex-shrink-0 rounded px-1 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-400 dark:hover:bg-indigo-950/30"
              >
                {building === i ? "…" : builtMsg === i ? "queued ✓" : "build"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
