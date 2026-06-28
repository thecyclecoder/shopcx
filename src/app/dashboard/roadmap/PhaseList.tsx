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

// chain-accumulation-built-phase-render (fixes E1): under M1's branch-accumulation model a BUILT phase
// carries `build_sha` and stays `in_progress` (M2 — `in_progress` is reserved-for-not-shipped) until M5's
// main promotion flips it to `shipped`. The CEO wants a built (committed-to-branch) phase to read DONE on
// the board, not the amber "Building" of a phase that's merely queued/in-flight. So the rendered status is
// DERIVED: a phase with `build_sha` set but not yet shipped/rejected shows the built glyph (teal "Built");
// a phase that is `in_progress` WITHOUT a `build_sha` is genuinely mid-build → amber "Building". The
// underlying `spec_phases.status` stays `in_progress` (the spec rolls up `in_testing` only when ALL phases
// are built — handled elsewhere); this is a rendering overlay only.
const BUILT_DOT = "bg-teal-500";
const BUILT_LABEL = "Built";
function isBuilt(p: { status: Phase; build_sha?: string | null }): boolean {
  return !!p.build_sha && p.status !== "shipped" && p.status !== "rejected";
}
/** The dot color for a phase's DERIVED render status (built-on-branch → teal, else the raw status color). */
function dotFor(p: { status: Phase; build_sha?: string | null }): string {
  return isBuilt(p) ? BUILT_DOT : DOT[p.status];
}

const GH_REPO = "thecyclecoder/shopcx";
function prUrl(n: number): string {
  return `https://github.com/${GH_REPO}/pull/${n}`;
}

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
                    title={statuses[i] === s && isBuilt({ status: statuses[i], build_sha: p.build_sha }) ? BUILT_LABEL : LABEL[s]}
                    onClick={() => setStatus(i, s)}
                    className={`h-2.5 w-2.5 rounded-full border ${
                      // The active dot follows the DERIVED status: a build_sha'd (built-on-branch) in_progress
                      // phase fills TEAL ("Built"), matching the badge — not the amber of a still-building phase.
                      statuses[i] === s ? `${dotFor({ status: statuses[i], build_sha: p.build_sha })} border-transparent` : "border-zinc-300 bg-transparent dark:border-zinc-600"
                    }`}
                  />
                ))}
              </span>
            ) : (
              // Read-only viewer: render the DERIVED status — a build_sha'd phase reads BUILT (teal), not amber.
              <span className={`mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotFor({ status: statuses[i], build_sha: p.build_sha })}`} />
            )}
            <span className={`flex-1 ${statuses[i] === "rejected" ? "text-zinc-400 line-through" : ""}`}>{p.title}</span>
            {/* chain-accumulation-built-phase-render (E1): a built-on-branch phase (build_sha, not yet shipped)
                reads "Built" — done building on the spec branch — instead of the amber in-progress dot/label. */}
            {isBuilt({ status: statuses[i], build_sha: p.build_sha }) && (
              <span
                title={`Built on branch${p.build_sha ? ` (${p.build_sha.slice(0, 7)})` : ""} — accumulated, awaiting promotion`}
                className="flex-shrink-0 rounded px-1 text-[10px] font-medium text-teal-600 dark:text-teal-400"
              >
                {BUILT_LABEL}
              </span>
            )}
            {/* spec-status-phase-pr-provenance Phase 3: the PR that shipped this phase (link to the merge).
                Only rendered for shipped phases that carry a `pr` tag — backfill or merge-hook stamps it. */}
            {statuses[i] === "shipped" && p.pr && (
              <a
                href={prUrl(p.pr)}
                target="_blank"
                rel="noreferrer"
                title={`Shipped by PR #${p.pr}${p.merge_sha ? ` (${p.merge_sha.slice(0, 7)})` : ""}`}
                className="flex-shrink-0 rounded px-1 text-[10px] font-medium text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
              >
                #{p.pr}
              </a>
            )}
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
