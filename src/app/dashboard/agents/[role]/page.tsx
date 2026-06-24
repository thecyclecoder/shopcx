"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { DirectorActivity } from "@/components/agents/director-activity";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import { XpCard, type DirectorXp } from "@/components/agents/xp-card";
import { AgentCoachingHistory } from "@/components/agents/agent-coaching-history";
import { AgentGradePanel } from "@/components/agents/agent-grade-panel";
import { DirectorAutonomy } from "@/components/agents/director-autonomy";
import { DirectorCoachChat } from "@/components/agents/director-coach-chat";
import { DirectorGradePanel } from "@/components/agents/director-grade-panel";
import { RoleInbox, AutonomyToggle } from "@/components/agents/role-inbox";

// Per-role profile detail page (agents-hub-role-inboxes spec, Phase 5).
// `/dashboard/agents/[role]` — one page for every seat (CEO · a director slug · a
// worker kind). Avatar + name + persona + a responsibilities list. The list precision
// climbs as you go down the org: WORKERS carry the most precise mandate (from the
// reskinnable personas config), DIRECTORS a higher-level mandate (from functions/*.md),
// the CEO the company-objective level (from goals/*.md). Reachable from any tab — the
// org-chart nodes, the Directors/Workers rosters — all point here.

interface WorkerLane {
  kind: string;
  label: string;
  description: string;
}
interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}
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

type Resolved =
  | { kind: "ceo" }
  | { kind: "director"; director: DirectorNode }
  | { kind: "worker"; worker: WorkerLane; director: DirectorNode }
  | { kind: "unknown" };

function resolveRole(org: OrgChart, role: string): Resolved {
  if (role === "ceo") return { kind: "ceo" };
  const director = org.directors.find((d) => d.slug === role);
  if (director) return { kind: "director", director };
  for (const d of org.directors) {
    const worker = d.workers.find((w) => w.kind === role);
    if (worker) return { kind: "worker", worker, director: d };
  }
  return { kind: "unknown" };
}

function ResponsibilityList({ items }: { items: { primary: string; secondary?: string }[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-zinc-400">No responsibilities recorded yet.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((it, i) => (
        <li
          key={i}
          className="flex gap-2.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
          <span className="min-w-0">
            <span className="block text-sm text-zinc-800 dark:text-zinc-200">{it.primary}</span>
            {it.secondary && <span className="mt-0.5 block text-[12px] text-zinc-400">{it.secondary}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ProfileCard({
  org,
  role,
  xp,
  onAutonomyChange,
}: {
  org: OrgChart;
  role: string;
  xp: Record<string, DirectorXp>;
  onAutonomyChange: () => void;
}) {
  const resolved = resolveRole(org, role);
  const functionSlugs = org.directors.map((d) => d.slug);

  if (resolved.kind === "unknown") {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-12 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No such role.</p>
        <p className="mt-1 text-[12px] text-zinc-400">
          “{role}” isn&apos;t a seat in the org chart.{" "}
          <Link href="/dashboard/agents" className="text-indigo-600 hover:underline dark:text-indigo-400">
            Back to the Agents hub →
          </Link>
        </p>
      </div>
    );
  }

  // Header bits + the responsibility list, by tier.
  let personaKey = role;
  let personaLabel: string | undefined;
  let tierLabel = "";
  let scopeLine = "";
  let responsibilities: { primary: string; secondary?: string }[] = [];
  let badge: React.ReactNode = null;
  let reportsTo: { name: string; role: string; href: string } | null = null;
  let extra: React.ReactNode = null;
  let xpCard: React.ReactNode = null;

  if (resolved.kind === "ceo") {
    personaKey = "ceo";
    tierLabel = "Company objectives";
    // The CEO's responsibilities ARE the finite goals (goals/*.md) — company-objective level.
    responsibilities = org.ceo.goals.map((g) => ({ primary: g.title, secondary: `${g.pct}% complete` }));
    // The per-role inbox (IA refactor) now lives on the profile — Approval Requests · Daily
    // Summaries · Decision history · Director grades. The shared board lives on the hub.
    extra = (
      <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Inbox</h2>
        <RoleInbox role="ceo" title="CEO" functionSlugs={functionSlugs} />
      </div>
    );
  } else if (resolved.kind === "director") {
    const d = resolved.director;
    personaKey = d.slug;
    personaLabel = d.title;
    tierLabel = "Mandates";
    scopeLine = d.summary;
    badge = <StatusBadge status={d.status} />;
    reportsTo = { name: getPersona("ceo").name, role: "CEO", href: "/dashboard/agents/ceo" };
    // A director's responsibilities are its higher-level mandates (functions/*.md).
    responsibilities = d.mandates.map((m) => ({
      primary: m.name,
      secondary: [m.metric, m.specCount > 0 ? `${m.specCount} spec${m.specCount === 1 ? "" : "s"}` : ""]
        .filter(Boolean)
        .join(" · "),
    }));
    // Gamified XP card (directors-board-gamified, M3 Phase 3) — derived, display-only counts.
    if (xp[d.slug]) {
      xpCard = (
        <div className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">XP</h2>
          <XpCard xp={xp[d.slug]} />
        </div>
      );
    }
    // The director's own team — its box agent_jobs lanes, each linking to its profile.
    const teamBlock =
      d.workers.length > 0 ? (
        <div className="mt-6">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Team · {d.workers.length} agent{d.workers.length === 1 ? "" : "s"}
          </h3>
          <div className="flex flex-wrap gap-2">
            {d.workers.map((w) => {
              const wp = getPersona(w.kind, w.label);
              return (
                <Link
                  key={w.kind}
                  href={`/dashboard/agents/${encodeURIComponent(w.kind)}`}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/30"
                >
                  <PersonaAvatar persona={wp} size={22} />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-zinc-800 dark:text-zinc-200">{wp.name}</span>
                    <span className="block font-mono text-[10px] text-zinc-400">{w.kind}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null;
    // Live activity feed — the director's own director_activity rows (is she alive + what she's doing).
    // P5: for the leash-bearing Platform director, show what she ACTUALLY does autonomously (leash-derived),
    // not just the functions/*.md charter mandates above.
    extra = (
      <>
        {d.slug === "platform" && (
          <div className="mt-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Grades · from the CEO</h3>
            <DirectorGradePanel />
          </div>
        )}
        {d.slug === "platform" && <DirectorAutonomy autonomous={d.autonomous} />}
        {d.slug === "platform" && (
          <div className="mt-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Coach Ada</h3>
            <DirectorCoachChat />
          </div>
        )}
        {teamBlock}
        <div className="mt-6">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Recent activity</h3>
          <DirectorActivity fn={d.slug} />
        </div>
        {/* Owner-only autonomy toggle (was on the hub's role header) — flips this director live/autonomous. */}
        <div className="mt-6">
          <AutonomyToggle director={d} onChange={onAutonomyChange} />
        </div>
        {/* The per-role inbox (IA refactor) — Approval Requests · Daily Summaries · Decision history · Director grades. */}
        <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Inbox</h2>
          <RoleInbox role={d.slug} title={getPersona(d.slug, d.title).name} functionSlugs={functionSlugs} />
        </div>
      </>
    );
  } else {
    // Worker — the most precise responsibility list (from the personas config).
    const { worker, director } = resolved;
    personaKey = worker.kind;
    personaLabel = worker.label;
    tierLabel = "Responsibilities";
    const wp = getPersona(worker.kind, worker.label);
    scopeLine = worker.description;
    const dp = getPersona(director.slug, director.title);
    reportsTo = { name: dp.name, role: dp.role, href: `/dashboard/agents/${encodeURIComponent(director.slug)}` };
    responsibilities = (wp.responsibilities ?? []).map((r) => ({ primary: r }));
    extra = (
      <>
        <p className="mt-6 text-[12px] text-zinc-400">
          Box lane <span className="font-mono text-zinc-500 dark:text-zinc-400">{worker.kind}</span> — its requests route
          up to the CEO inbox until {dp.name} ({dp.role}) goes live (approval-routing engine, M2).
        </p>
        {/* worker-grading Phase 3: the Director's grade rollup + the worker's recent graded actions. */}
        <div className="mt-6">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Grades · from {dp.name} ({dp.role})
          </h3>
          <AgentGradePanel kind={worker.kind} />
        </div>
        {/* worker-coaching-loop: the director's messages to this worker over time (its coaching history). */}
        <div className="mt-6">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Coaching history · from {dp.name} ({dp.role})
          </h3>
          <AgentCoachingHistory kind={worker.kind} />
        </div>
      </>
    );
  }

  const persona = getPersona(personaKey, personaLabel);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4">
        <PersonaAvatar persona={persona} size={64} />
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {persona.name}
            <span className="text-base font-normal text-zinc-400">· {persona.role}</span>
            {badge}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{persona.personality}</p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1 text-[12px]">
          {reportsTo && (
            <Link href={reportsTo.href} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
              reports to {reportsTo.name} · {reportsTo.role} →
            </Link>
          )}
        </div>
      </div>

      {scopeLine && persona.personality !== scopeLine && (
        <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">{scopeLine}</p>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{tierLabel}</h2>
        <ResponsibilityList items={responsibilities} />
      </div>

      {xpCard}
      {extra}
    </div>
  );
}

export default function AgentProfilePage() {
  const params = useParams<{ role: string }>();
  const role = decodeURIComponent(params.role);
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [xp, setXp] = useState<Record<string, DirectorXp>>({});
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

  const loadXp = useCallback(
    () =>
      fetch("/api/developer/agents/xp")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: { xp: Record<string, DirectorXp> }) => setXp(d.xp ?? {}))
        .catch(() => setXp({})),
    [],
  );

  useEffect(() => {
    if (workspace.role !== "owner") return;
    loadOrg();
    loadXp();
  }, [workspace.role, loadOrg, loadXp]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-[12px] text-zinc-400">
        <Link href="/dashboard/agents" className="hover:text-zinc-700 dark:hover:text-zinc-200">
          Agents
        </Link>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">{role}</span>
      </div>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading profile…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the profile.
        </div>
      ) : org ? (
        <ProfileCard org={org} role={role} xp={xp} onAutonomyChange={loadOrg} />
      ) : null}
    </div>
  );
}
