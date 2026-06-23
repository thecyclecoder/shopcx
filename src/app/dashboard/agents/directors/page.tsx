"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";

// Directors roster (agents-hub-role-inboxes spec, Phase 5) — `/dashboard/agents/directors`.
// The CEO + every functions/*.md director as a card; each row is clickable → its
// `/dashboard/agents/[role]` profile (same profile page everywhere). Brain-driven via
// GET /api/developer/agents — add a functions/*.md director and it appears, no code change.

interface DirectorMandate { name: string; metric?: string; specCount: number }
interface WorkerLane { kind: string; label: string; description: string }
interface DirectorNode {
  slug: string;
  title: string;
  summary: string;
  mandates: DirectorMandate[];
  goalSlugs: string[];
  workers: WorkerLane[];
  status: "offline" | "live" | "autonomous";
  live: boolean;
  autonomous: boolean;
}
interface OrgChart {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

function Row({
  href,
  slug,
  label,
  subtitle,
  badge,
}: {
  href: string;
  slug: string;
  label?: string;
  subtitle: string;
  badge?: React.ReactNode;
}) {
  const persona = getPersona(slug, label);
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
    >
      <PersonaAvatar persona={persona} size={40} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
          <span className="text-[12px] text-zinc-400">{persona.role}</span>
          {badge}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-zinc-500 dark:text-zinc-400">{subtitle}</span>
      </span>
      <span className="shrink-0 text-zinc-300 dark:text-zinc-600">→</span>
    </Link>
  );
}

export default function DirectorsRosterPage() {
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
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Directors</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-md p-6">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Directors</h1>
        <Link href="/dashboard/agents" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
          Agents hub →
        </Link>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        The CEO and each function director — read live from the brain. Click any row for its profile + responsibilities.
      </p>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading directors…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the roster.
        </div>
      ) : org ? (
        <div className="space-y-2">
          <Row
            href="/dashboard/agents/ceo"
            slug="ceo"
            subtitle={`${org.ceo.goals.length} active goal${org.ceo.goals.length === 1 ? "" : "s"}`}
          />
          {org.directors.map((d) => (
            <Row
              key={d.slug}
              href={`/dashboard/agents/${encodeURIComponent(d.slug)}`}
              slug={d.slug}
              label={d.title}
              subtitle={`${d.mandates.length} mandate${d.mandates.length === 1 ? "" : "s"} · ${d.workers.length} worker${
                d.workers.length === 1 ? "" : "s"
              }`}
              badge={<StatusBadge status={d.status} />}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
