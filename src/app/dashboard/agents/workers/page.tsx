"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";

// Workers roster (agents-hub-role-inboxes spec, Phase 5) — `/dashboard/agents/workers`.
// Every box agent_jobs lane grouped under its owning director; each chip is clickable →
// its `/dashboard/agents/[role]` profile + precise responsibilities. Brain-driven via
// GET /api/developer/agents (the Control Tower registry's agent-kind loops).

interface WorkerLane { kind: string; label: string; description: string }
interface DirectorNode {
  slug: string;
  title: string;
  workers: WorkerLane[];
}
interface OrgChart {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

function WorkerChip({ kind, label, description }: { kind: string; label: string; description: string }) {
  const persona = getPersona(kind, label);
  return (
    <Link
      href={`/dashboard/agents/${encodeURIComponent(kind)}`}
      title={description}
      className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2.5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
    >
      <PersonaAvatar persona={persona} size={32} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
          <span className="text-[11px] text-zinc-400">{persona.role}</span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-400">{kind}</span>
      </span>
    </Link>
  );
}

export default function WorkersRosterPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

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

  useEffect(() => {
    if (workspace.role !== "owner") return;
    loadOrg();
  }, [workspace.role, loadOrg]);

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
                    <WorkerChip key={w.kind} kind={w.kind} label={w.label} description={w.description} />
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
