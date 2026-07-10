"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { useSectionNav, type SectionNavItem } from "@/lib/section-nav-context";
import { getPersona } from "@/lib/agents/personas";
import { DirectorActivity } from "@/components/agents/director-activity";
import { DirectorGuide } from "@/components/agents/director-guide";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import { XpCard, type DirectorXp } from "@/components/agents/xp-card";
import { AgentCoachingHistory } from "@/components/agents/agent-coaching-history";
import { AgentGradePanel } from "@/components/agents/agent-grade-panel";
import { AgentKpiView } from "@/components/agents/agent-kpi-view";
import { ModelTierCard } from "@/components/agents/model-tier-card";
import { DirectorAutonomy } from "@/components/agents/director-autonomy";
import { DirectorCoachChat } from "@/components/agents/director-coach-chat";
import { DirectorGradePanel } from "@/components/agents/director-grade-panel";
import { DirectiveCard } from "@/components/agents/directive-card";
import { RoleInbox, AutonomyToggle } from "@/components/agents/role-inbox";
import { CfoFinancials } from "@/components/agents/cfo-financials";
import DepartmentScorecardCard from "./DepartmentScorecardCard";

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
  ceo: {
    goals: { slug: string; title: string; pct: number; status: "proposed" | "greenlit" | "complete"; proposedBy?: string; proposedByLabel?: string }[];
    // Phase 2 (god-mode-becomes-ceo-executive-assistant-agent) — CEO-owned workers so
    // `/dashboard/agents/god-mode` (Eve's profile) resolves via resolveRole, not "unknown".
    workers: WorkerLane[];
  };
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
  // Phase 2 (god-mode-becomes-ceo-executive-assistant-agent) — a CEO-owned worker (Eve today)
  // resolves through the SAME worker branch, with the CEO seat standing in as the reports-to
  // "director". No parallel code path — a synthetic DirectorNode-shaped stub carries the CEO
  // as her supervisor, so /dashboard/agents/god-mode shows reports-to Henry, not "unknown".
  const ceoWorker = (org.ceo.workers ?? []).find((w) => w.kind === role);
  if (ceoWorker) {
    const ceoStub: DirectorNode = {
      slug: "ceo",
      title: "CEO",
      summary: "",
      mandates: [],
      goalSlugs: [],
      workers: org.ceo.workers ?? [],
      status: "autonomous",
      live: true,
      autonomous: true,
    };
    return { kind: "worker", worker: ceoWorker, director: ceoStub };
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
  // Contextual sidebar takeover (#16): a director OR worker profile registers its section nav, which
  // replaces the main app sidebar; the active section is the `?s=` query (default overview). Hooks
  // before any early return. Workers gained a nav in agents-sidebar-kpis-and-profile-redesign Phase 1
  // (Overview + KPIs) so Cleo's KPIs are a first-class sidebar tab, not a faint corner link. Directors
  // gained a matching KPIs tab in the same phase.
  const searchParams = useSearchParams();
  const activeSection = searchParams.get("s") || "overview";
  const { setNav } = useSectionNav();
  const isDirector = resolved.kind === "director";
  const directorSlug = isDirector ? resolved.director.slug : "";
  const directorTitle = isDirector ? resolved.director.title : "";
  const isWorker = resolved.kind === "worker";
  const workerKind = isWorker ? resolved.worker.kind : "";
  const workerLabel = isWorker ? resolved.worker.label : "";
  useEffect(() => {
    if (isDirector) {
      const isPlatform = directorSlug === "platform";
      const isCfo = directorSlug === "cfo";
      const sections: SectionNavItem[] = [
        { key: "overview", label: "Overview" },
        // The friendly, self-updating plain-English intro — right after Overview (director-guide-tab).
        { key: "guide", label: "Guide" },
        // The CFO (Grace) owns the P&L visual — Revenue / Net Profit / Mgmt Fees / NP + Addbacks.
        ...(isCfo ? [{ key: "financials", label: "Financials" } as SectionNavItem] : []),
        ...(isPlatform ? [{ key: "grades", label: "Grades" } as SectionNavItem, { key: "coach", label: "Coach" } as SectionNavItem] : []),
        { key: "activity", label: "Activity" },
        { key: "autonomy", label: "Autonomy" },
        { key: "inbox", label: "Inbox" },
        // agents-sidebar-kpis-and-profile-redesign Phase 1 — surface computeAgentKpis for directors too.
        { key: "kpi", label: "KPIs" },
      ];
      setNav({ title: getPersona(directorSlug, directorTitle).name, basePath: `/dashboard/agents/${encodeURIComponent(role)}`, backHref: "/dashboard/agents", backLabel: "Agents", sections });
      return () => setNav(null);
    }
    if (isWorker) {
      // Workers get the Director-style takeover (Phase 1 opened the surface with a minimal
      // Overview + KPIs pair). Phase 2 promotes each heavy element that used to stack on the
      // Overview into its own sidebar sub-page — Grades / Coaching / Activity / Model tier —
      // mirroring the Director section-switch shape (one component per activeSection).
      const sections: SectionNavItem[] = [
        { key: "overview", label: "Overview" },
        { key: "kpi", label: "KPIs" },
        { key: "grades", label: "Grades" },
        { key: "coaching", label: "Coaching" },
        { key: "activity", label: "Activity" },
        { key: "model", label: "Model tier" },
      ];
      setNav({ title: getPersona(workerKind, workerLabel).name, basePath: `/dashboard/agents/${encodeURIComponent(role)}`, backHref: "/dashboard/agents", backLabel: "Agents", sections });
      return () => setNav(null);
    }
    // CEO + unknown roles keep the main app sidebar (no takeover).
    setNav(null);
  }, [isDirector, directorSlug, directorTitle, isWorker, workerKind, workerLabel, role, setNav]);

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
    // The CEO's responsibilities ARE the finite goals (goals/*.md) — company-objective level. A
    // director-proposed goal (director-proposed-goals Phase 2) shows its proposer + that it AWAITS the CEO's
    // greenlight, so the CEO sees what a director is proposing vs what's already activated.
    responsibilities = org.ceo.goals.map((g) => ({
      primary: g.title,
      secondary:
        g.status === "proposed"
          ? `⏳ Proposed${g.proposedByLabel ? ` by ${g.proposedByLabel}` : ""} · awaiting your greenlight`
          : `${g.status === "complete" ? "Complete" : "Greenlit"} · ${g.pct}% complete`,
    }));
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
    scopeLine = d.summary;
    badge = <StatusBadge status={d.status} />;
    reportsTo = { name: getPersona("ceo").name, role: "CEO", href: "/dashboard/agents/ceo" };
    const isPlatform = d.slug === "platform";
    const mandates = d.mandates.map((m) => ({
      primary: m.name,
      secondary: [m.metric, m.specCount > 0 ? `${m.specCount} spec${m.specCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · "),
    }));
    const teamBlock =
      d.workers.length > 0 ? (
        <div>
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
    // Sidebar-takeover IA (#16): render ONE section at a time (the active `?s=` from the contextual nav).
    const section =
      activeSection === "guide" ? (
        <DirectorGuide slug={d.slug} />
      ) : activeSection === "financials" && d.slug === "cfo" ? (
        <CfoFinancials />
      ) : activeSection === "grades" && isPlatform ? (
        <DirectorGradePanel />
      ) : activeSection === "coach" && isPlatform ? (
        <DirectorCoachChat />
      ) : activeSection === "kpi" ? (
        // agents-sidebar-kpis-and-profile-redesign Phase 1 — the same view as the standalone
        // /dashboard/agents/[role]/kpi page, rendered in-place via the shared component.
        <AgentKpiView role={d.slug} />
      ) : activeSection === "activity" ? (
        <DirectorActivity fn={d.slug} />
      ) : activeSection === "autonomy" ? (
        <div className="space-y-6">
          {isPlatform && <DirectorAutonomy autonomous={d.autonomous} />}
          {/* box-agent-model-tiers Phase 4: the director's own model tier — her change routes to the CEO. */}
          {isPlatform && <ModelTierCard kind="platform-director" />}
          <AutonomyToggle director={d} onChange={onAutonomyChange} />
        </div>
      ) : activeSection === "inbox" ? (
        <RoleInbox role={d.slug} title={getPersona(d.slug, d.title).name} functionSlugs={functionSlugs} hideGrades />
      ) : (
        <div className="space-y-8">
          {/* The Platform/DevOps Director owns the department scorecard — surface its daily-pulse KPIs at the
              top of her Overview (was buried at /dashboard/agents/scorecard). platform-scorecard-on-profile. */}
          {isPlatform && <DepartmentScorecardCard />}
          <div>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Mandates</h2>
            <ResponsibilityList items={mandates} />
          </div>
          {xp[d.slug] && (
            <div>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">XP</h2>
              <XpCard xp={xp[d.slug]} />
            </div>
          )}
          {teamBlock}
        </div>
      );
    extra = <div className="mt-6">{section}</div>;
  } else {
    // Worker — the most precise responsibility list (from the personas config).
    const { worker, director } = resolved;
    personaKey = worker.kind;
    personaLabel = worker.label;
    const wp = getPersona(worker.kind, worker.label);
    scopeLine = worker.description;
    const dp = getPersona(director.slug, director.title);
    reportsTo = { name: dp.name, role: dp.role, href: `/dashboard/agents/${encodeURIComponent(director.slug)}` };
    // Sidebar-takeover IA — Phase 2 mirrors the Director section-switch shape: render ONE section
    // component per activeSection (default = overview). Overview is persona-only (avatar + name +
    // reports-to + scope + Responsibilities + box-lane footer); Grades / Coaching / Activity /
    // Model tier each moved off the single scrolling page into their own sidebar sub-page. The
    // faint 'KPIs →' corner link is retired — KPIs is a real sidebar tab as of Phase 1.
    if (activeSection === "kpi") {
      // KPIs is a first-class sidebar tab for workers (the fix for "I can't see Cleo's KPIs").
      // Suppress the Responsibilities block since KPIs answers the liveness + outcome question.
      tierLabel = "";
      responsibilities = [];
      extra = (
        <div className="mt-6">
          <AgentKpiView role={worker.kind} />
        </div>
      );
    } else if (activeSection === "grades") {
      // worker-grading Phase 3 — the director's grade rollup + this worker's recent graded actions.
      tierLabel = "";
      responsibilities = [];
      extra = (
        <div className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Grades · from {dp.name} ({dp.role})
          </h2>
          <AgentGradePanel kind={worker.kind} />
        </div>
      );
    } else if (activeSection === "coaching") {
      // worker-coaching-loop — the director's messages to this worker over time.
      tierLabel = "";
      responsibilities = [];
      extra = (
        <div className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
            Coaching history · from {dp.name} ({dp.role})
          </h2>
          <AgentCoachingHistory kind={worker.kind} />
        </div>
      );
    } else if (activeSection === "activity") {
      // Recent actions this worker filed under its supervising director (metadata.actor).
      // Not gated by hideIfEmpty here: this is the dedicated Activity tab, so an empty state
      // is the honest answer (no `hideIfEmpty` — the tab shouldn't collapse silently).
      tierLabel = "";
      responsibilities = [];
      extra = (
        <div className="mt-6">
          <DirectorActivity
            fn={director.slug}
            actor={worker.kind}
            heading={`Recent activity · under ${dp.name} (${dp.role})`}
          />
        </div>
      );
    } else if (activeSection === "model") {
      // box-agent-model-tiers Phase 4 — the worker's current model tier + governed change history.
      tierLabel = "";
      responsibilities = [];
      extra = (
        <div className="mt-6">
          <ModelTierCard kind={worker.kind} />
        </div>
      );
    } else {
      // Overview (default) — persona-only: Responsibilities from the personas config +
      // a small box-lane routing footer. Nothing else stacked here.
      tierLabel = "Responsibilities";
      responsibilities = (wp.responsibilities ?? []).map((r) => ({ primary: r }));
      extra = (
        <p className="mt-6 text-[12px] text-zinc-400">
          Box lane <span className="font-mono text-zinc-500 dark:text-zinc-400">{worker.kind}</span> — its requests route
          up to the CEO inbox until {dp.name} ({dp.role}) goes live (approval-routing engine, M2).
        </p>
      );
    }
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
          {/* agents-sidebar-kpis-and-profile-redesign Phase 2 — the faint 'KPIs →' corner link is
              retired. KPIs is a real sidebar tab for every director + worker profile as of Phase 1. */}
        </div>
      </div>

      {scopeLine && persona.personality !== scopeLine && (
        <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">{scopeLine}</p>
      )}

      {/* director-executable-plans-and-priority-hub-pip Phase 1 — surface the platform director's ONE
          active directive at the top of her profile so it's visible across every section tab. */}
      {resolved.kind === "director" && resolved.director.slug === "platform" && (
        <div className="mt-5">
          <DirectiveCard functionSlug="platform" title={persona.name} />
        </div>
      )}

      {/* Directors render their content via section-gated `extra` (sidebar takeover); CEO/agents use this block. */}
      {tierLabel && (
        <div className="mt-6">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{tierLabel}</h2>
          <ResponsibilityList items={responsibilities} />
        </div>
      )}

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
