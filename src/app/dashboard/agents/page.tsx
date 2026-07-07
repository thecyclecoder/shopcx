"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import { OrgTree } from "@/components/agents/org-tree";
import { BoardChannel } from "@/components/agents/board-channel";
import { DirectiveCard } from "@/components/agents/directive-card";

// Agents hub (agents-hub-role-inboxes spec; IA refactor) — the owner-only org-chart surface.
// Left: CEO → Directors, read from functions/+goals/ via brain-roadmap; each row LINKS to that
// role's profile page (/dashboard/agents/[role]), which now hosts the per-role inbox.
// Main: the shared Slack-style #directors board (one workspace-wide team channel). The per-role
// inbox tabs (Approval Requests · Daily Summaries · Decision history · Director grades) live on
// the profile page, not here.

interface WorkerLane {
  kind: string;
  label: string;
  description: string;
  status: "active" | "idle-healthy" | "inactive";
  statusReason?: string;
  flagged?: boolean;
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
  ceo: {
    goals: { slug: string; title: string; pct: number }[];
    // Phase 2 (god-mode-becomes-ceo-executive-assistant-agent): CEO-owned workers rendered under
    // the CEO seat — Eve (the god-mode cockpit executive assistant) today. Populated server-side
    // in `getOrgChart` from every MONITORED_LOOPS entry with owner="ceo".
    workers: WorkerLane[];
  };
  directors: DirectorNode[];
}

// ── Left nav ──────────────────────────────────────────────────────────────────

function RoleNav({ org }: { org: OrgChart }) {
  const ceo = getPersona("ceo");
  return (
    <nav className="space-y-1">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">CEO</p>
      <Link
        href="/dashboard/agents/ceo"
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        <PersonaAvatar persona={ceo} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{ceo.name}</span>
            <span className="text-[11px] text-zinc-400">{ceo.role}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {org.ceo.goals.length} active goal{org.ceo.goals.length === 1 ? "" : "s"}
          </span>
        </span>
      </Link>
      {/* god-mode-becomes-ceo-executive-assistant-agent Phase 2 — CEO-owned workers rendered under
          the CEO seat with the SAME shape as a director's workers list, so Eve (the god-mode
          executive assistant) reaches her profile + KPIs in one click and is NEVER shown under Ada. */}
      {org.ceo.workers.length > 0 && (
        <ul className="mt-0.5 ml-3 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
          {org.ceo.workers.map((w) => {
            const wp = getPersona(w.kind, w.label);
            return (
              <li key={w.kind} className="flex items-center gap-1">
                <Link
                  href={`/dashboard/agents/${encodeURIComponent(w.kind)}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  title={w.description}
                >
                  <PersonaAvatar persona={wp} size={20} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-700 dark:text-zinc-300">
                    {wp.name}
                  </span>
                </Link>
                <Link
                  href={`/dashboard/agents/${encodeURIComponent(w.kind)}/kpi`}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                  title={`${wp.name}'s KPIs`}
                >
                  KPIs
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Directors + Agents</p>
      <div className="space-y-2">
        {org.directors.map((d) => {
          const persona = getPersona(d.slug, d.title);
          return (
            <div key={d.slug}>
              <Link
                href={`/dashboard/agents/${encodeURIComponent(d.slug)}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <PersonaAvatar persona={persona} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
                    <span className="text-[11px] text-zinc-400">{persona.role}</span>
                  </span>
                  <span className="mt-0.5 block">
                    <StatusBadge status={d.status} />
                  </span>
                </span>
              </Link>
              {/* agents-sidebar-kpis-and-profile-redesign Phase 3 — workers grouped under their owning director,
                  each with a direct KPIs affordance so the founder reaches Cleo (and any worker's KPIs) in one
                  click from the hub without switching to Org chart. */}
              {d.workers.length > 0 && (
                <ul className="mt-0.5 ml-3 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  {d.workers.map((w) => {
                    const wp = getPersona(w.kind, w.label);
                    return (
                      <li key={w.kind} className="flex items-center gap-1">
                        <Link
                          href={`/dashboard/agents/${encodeURIComponent(w.kind)}`}
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          title={w.description}
                        >
                          <PersonaAvatar persona={wp} size={20} />
                          <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-700 dark:text-zinc-300">
                            {wp.name}
                          </span>
                        </Link>
                        <Link
                          href={`/dashboard/agents/${encodeURIComponent(w.kind)}/kpi`}
                          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                          title={`${wp.name}'s KPIs`}
                        >
                          KPIs
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  // "inbox" = the role nav + shared #directors board (the default); "org" = the visual org-tree.
  const [view, setView] = useState<"org" | "inbox">("inbox");
  // The board's filter input (was the InboxShell filter) — narrows the shared #directors board.
  const [q, setQ] = useState("");

  // Deep-link support: links here with ?view=inbox|org. Read once on mount (client-only).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const v = p.get("view");
    if (v === "inbox" || v === "org") setView(v);
  }, []);

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

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
            {(["org", "inbox"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  view === v
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {v === "org" ? "Org chart" : "Board"}
              </button>
            ))}
          </div>
          <Link
            href="/dashboard/agents/scorecard"
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Scorecard →
          </Link>
          <Link
            href="/dashboard/developer/control-tower"
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Control Tower →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        The org chart — CEO · Directors · Agents — read live from the brain. Pick a seat to open its profile + inbox;
        the shared #directors board is the team channel below.
      </p>

      {/* director-executable-plans-and-priority-hub-pip Phase 1 — the always-visible card for the platform
          director's ONE active directive (if any). Mirrors how the standing pass already headlines it. */}
      <div className="mb-5">
        <DirectiveCard functionSlug="platform" title="Ada" />
      </div>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading the org chart…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the Agents hub.
        </div>
      ) : org && view === "org" ? (
        // The visual employee/org chart — CEO → Directors → Workers. Every node
        // links to that role's profile detail page (/dashboard/agents/[role]).
        <OrgTree org={org} />
      ) : org ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="lg:border-r lg:border-zinc-200 lg:pr-4 dark:lg:border-zinc-800">
            <RoleNav org={org} />
          </aside>
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter the board…"
                className="w-44 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              />
            </div>
            {/* The Slack-style #directors board (directors-board-gamified, M3) — ONE workspace-wide team channel. */}
            <BoardChannel filter={q} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
