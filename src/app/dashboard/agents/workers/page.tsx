"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, WorkerStatusBadge, type WorkerLiveness } from "@/components/agents/persona-chip";

// Workers roster (agents-hub-role-inboxes spec, Phase 5) — `/dashboard/agents/workers`.
// Every box agent_jobs lane grouped under its owning director; each chip is clickable →
// its `/dashboard/agents/[role]` profile + precise responsibilities. Brain-driven via
// GET /api/developer/agents (the Control Tower registry's agent-kind loops).

interface WorkerLane { kind: string; label: string; description: string; status: WorkerLiveness; statusReason?: string; flagged?: boolean; loopKind?: string }

// How this agent runs — surfaced as a small type chip so a human can tell a box lane from a cron / reactive
// agent at a glance. agent-kind = a box claude -p lane; cron = scheduled; reactive = fired by an event.
const LOOP_TYPE: Record<string, { label: string; cls: string }> = {
  "agent-kind": { label: "lane", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" },
  cron: { label: "cron", cls: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" },
  reactive: { label: "reactive", cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  "inline-agent": { label: "inline", cls: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" },
};
interface DirectorNode {
  slug: string;
  title: string;
  workers: WorkerLane[];
}
interface OrgChart {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

type Rollup = { average: number | null; count: number; drop: number | null };

/** The standing rollup score badge (last-10 avg) — color-coded, with a slip flag. */
function ScoreBadge({ score }: { score?: Rollup }) {
  if (!score || score.average == null || score.count === 0) {
    return <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-1 text-[11px] font-medium text-zinc-400 dark:bg-zinc-800">— ungraded</span>;
  }
  const a = score.average;
  const cls =
    a >= 8
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
      : a >= 7
        ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        : a >= 5
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
  const slipping = score.drop != null && score.drop > 1.5;
  return (
    <span className={`shrink-0 rounded-md px-2 py-1 text-center ${cls}`} title={`last-${score.count} average${slipping ? " · slipping" : ""}`}>
      <span className="block text-[13px] font-bold leading-none">{a.toFixed(1)}</span>
      <span className="block text-[9px] leading-tight opacity-70">/10{slipping ? " ▼" : ""}</span>
    </span>
  );
}

function AgentChip({ worker, score }: { worker: WorkerLane; score?: Rollup }) {
  const { kind, label, description, status, statusReason, flagged, loopKind } = worker;
  const loopType = loopKind ? LOOP_TYPE[loopKind] : undefined;
  const persona = getPersona(kind, label);
  return (
    <Link
      href={`/dashboard/agents/${encodeURIComponent(kind)}`}
      title={description}
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
    >
      {/* agents-workers-card-name-readable: name + grade on the TOP row (name gets the full width so
          short names like "Cleo"/"Dahlia" never truncate to "C…"/"Da…"), everything else (role, kind,
          type + status) drops to a wrapping SECOND row. */}
      <span className="flex items-center gap-2.5">
        <PersonaAvatar persona={persona} size={32} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
        <ScoreBadge score={score} />
      </span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{persona.role}</span>
        <span className="font-mono text-[10px] text-zinc-400">{kind}</span>
        {loopType && (
          <span title={`Runs as a ${loopKind} loop`} className={`rounded px-1 text-[9px] font-medium ${loopType.cls}`}>
            {loopType.label}
          </span>
        )}
        {flagged && (
          <span
            title="Live lane with no MONITORED_LOOPS row — flagged by the roster drift audit."
            className="rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
          >
            unregistered
          </span>
        )}
        <WorkerStatusBadge status={status} reason={statusReason} />
      </span>
    </Link>
  );
}

export default function WorkersRosterPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [rollups, setRollups] = useState<Record<string, Rollup>>({});

  const loadOrg = useCallback(
    () =>
      fetch("/api/developer/agents")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: OrgChart) => {
          setOrg(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [],
  );

  const loadRollups = useCallback(
    () =>
      fetch("/api/developer/agents/rollups")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { rollups?: Record<string, Rollup> } | null) => d?.rollups && setRollups(d.rollups))
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    if (workspace.role !== "owner") return;
    loadOrg();
    loadRollups();
  }, [workspace.role, loadOrg, loadRollups]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const directorsWithWorkers = (org?.directors ?? []).filter((d) => d.workers.length > 0);

  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <Link href="/dashboard/agents" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          Agents hub →
        </Link>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        Every box agent lane, grouped under its director. Click an agent for its profile + precise responsibilities.
      </p>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading agents…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the roster.
        </div>
      ) : org ? (
        <div className="space-y-6">
          {directorsWithWorkers.map((d) => {
            const dp = getPersona(d.slug, d.title);
            return (
              <section key={d.slug}>
                <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-zinc-500 dark:text-zinc-400">
                  <Link
                    href={`/dashboard/agents/${encodeURIComponent(d.slug)}`}
                    className="flex items-center gap-1.5 hover:text-zinc-800 dark:hover:text-zinc-200"
                  >
                    <span aria-hidden>{dp.emoji}</span>
                    {dp.name} · {dp.role}
                  </Link>
                  <span className="text-zinc-300 dark:text-zinc-600">·</span>
                  <span className="text-[11px] font-normal text-zinc-400">{d.workers.length}</span>
                </h2>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {d.workers.map((w) => (
                    <AgentChip key={w.kind} worker={w} score={rollups[w.kind]} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
