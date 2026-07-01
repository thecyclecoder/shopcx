"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona, PERSONAS } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";
import { KpiCard, PostureCard } from "@/components/agents/kpi-card";
import type { AgentKpis } from "@/lib/agents/agent-kpis";

// Per-agent KPI page (agent-kpi-pages-cleo-first Phase 2). One page per agent kind
// (e.g. `/dashboard/agents/storefront-optimizer/kpi` — Cleo's), rendered generically off
// the SDK's tiered structure so a NEW agent kind gets a page from day one via the generic
// fallback. Cleo's is the featured one: her four-tier CRO KPI charter, with the "On it"
// posture + predicted LTV/visitor as the headline row.
//
// The persona identity (avatar + name) sits at the top so the page carries the agent's
// visual identity — the same "who am I looking at" cue the profile page uses.

const POLL_MS = 30_000;

export default function AgentKpiPage() {
  const params = useParams<{ role: string }>();
  const role = decodeURIComponent(params.role);
  const workspace = useWorkspace();
  const persona = getPersona(role);
  // A kind we recognise = it's in the persona registry (the same registry the profile
  // page resolves against). The KPI endpoint still works for unknown kinds via the
  // generic fallback, but we surface a light "unknown agent" note in that case.
  const known = role in PERSONAS;

  const [data, setData] = useState<AgentKpis | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(
      `/api/workspaces/${workspace.id}/agent-kpis?kind=${encodeURIComponent(role)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: AgentKpis) => {
        setData(d);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [workspace.id, role]);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [workspace.role, load]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">KPIs</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const headline = data?.headline ?? [];
  const tiers = data?.tiers ?? [];
  // Tier 1 gets the PostureCard treatment — SDK convention: its key is either "on-it"
  // (bespoke Cleo definition) or "activity" (generic fallback), both are OK to promote.
  const postureTierKey = tiers[0]?.key;
  const postureTier = tiers[0];
  const restTiers = tiers.slice(1);
  // The "primary outcome" headline card = the second headline entry from the SDK
  // (Cleo: LTV/visitor; generic: avg grade). The first is the on-it card, rendered as
  // the richer posture card variant.
  const primaryOutcome = headline[1] ?? null;

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

      {loading && !data ? (
        <div className="mt-8 py-12 text-center text-sm text-zinc-400">Loading KPIs…</div>
      ) : err && !data ? (
        <div className="mt-8 rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load KPIs ({err}).
        </div>
      ) : data ? (
        <>
          <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2">
            {postureTier && <PostureCard cards={postureTier.cards} />}
            {primaryOutcome && <KpiCard card={primaryOutcome} />}
          </section>

          {postureTier && postureTier.cards.length > 0 && (
            <TierSection
              label={postureTier.label}
              subtitle="Liveness + posture — is this agent on it right now?"
              cards={postureTier.cards}
              anchor={postureTierKey}
            />
          )}

          {restTiers.map((t) => (
            <TierSection key={t.key} label={t.label} cards={t.cards} anchor={t.key} />
          ))}

          {tiers.length === 0 && (
            <div className="mt-8 rounded-lg border border-dashed border-zinc-200 py-10 text-center text-sm text-zinc-400 dark:border-zinc-800">
              No KPI tiers to render yet.
            </div>
          )}

          <p className="mt-6 text-[11px] text-zinc-400">
            Snapshot: {new Date(data.generatedAt).toLocaleString()} · refreshes every{" "}
            {Math.round(POLL_MS / 1000)}s
          </p>
        </>
      ) : null}
    </div>
  );
}

function TierSection({
  label,
  subtitle,
  cards,
  anchor,
}: {
  label: string;
  subtitle?: string;
  cards: AgentKpis["tiers"][number]["cards"];
  anchor: string;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="mt-8" id={`tier-${anchor}`}>
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          {label}
        </h2>
        {subtitle && <span className="text-[11px] text-zinc-400">{subtitle}</span>}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <KpiCard key={c.key} card={c} />
        ))}
      </div>
    </section>
  );
}
