"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona, PERSONAS } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";
import { AgentKpiView } from "@/components/agents/agent-kpi-view";

// Per-agent KPI page (agent-kpi-pages-cleo-first Phase 2). One page per agent kind
// (e.g. `/dashboard/agents/storefront-optimizer/kpi` — Cleo's), rendered generically off
// the SDK's tiered structure so a NEW agent kind gets a page from day one via the generic
// fallback. Cleo's is the featured one: her four-tier CRO KPI charter, with the "On it"
// posture + predicted LTV/visitor as the headline row.
//
// The persona identity (avatar + name) sits at the top so the page carries the agent's
// visual identity — the same "who am I looking at" cue the profile page uses. The KPI
// cards themselves are rendered by <AgentKpiView>, which is ALSO used by the profile
// page's `?s=kpi` sidebar section (agents-sidebar-kpis-and-profile-redesign Phase 1).

export default function AgentKpiPage() {
  const params = useParams<{ role: string }>();
  const role = decodeURIComponent(params.role);
  const workspace = useWorkspace();
  const persona = getPersona(role);
  // A kind we recognise = it's in the persona registry (the same registry the profile
  // page resolves against). The KPI endpoint still works for unknown kinds via the
  // generic fallback, but we surface a light "unknown agent" note in that case.
  const known = role in PERSONAS;

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">KPIs</h1>
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
        <Link
          href={`/dashboard/agents/${encodeURIComponent(role)}`}
          className="hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          {persona.name}
        </Link>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">KPIs</span>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <PersonaAvatar persona={persona} size={56} />
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {persona.name}
            <span className="text-base font-normal text-zinc-400">· KPIs</span>
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">
            {persona.role} · {persona.personality}
          </p>
          {!known && (
            <p className="mt-1 text-[12px] text-zinc-400">
              No bespoke KPI definition — rendered from the generic fallback.
            </p>
          )}
        </div>
      </div>

      <div className="mt-6">
        <AgentKpiView role={role} />
      </div>
    </div>
  );
}
