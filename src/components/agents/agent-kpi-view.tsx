"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { KpiCard, PostureCard } from "@/components/agents/kpi-card";
import type { AgentKpis } from "@/lib/agents/agent-kpis";

// Reusable KPI view for a per-agent KPI dashboard. Extracted from the standalone
// /dashboard/agents/[role]/kpi page (agent-kpi-pages-cleo-first Phase 2) so the SAME
// cards render both there AND inside the profile page's `?s=kpi` sidebar section
// (agents-sidebar-kpis-and-profile-redesign Phase 1) — no duplicated rendering.
//
// The persona banner + breadcrumbs are caller-owned (they differ per surface); this
// component renders only the KPI body: posture headline + tiered KpiCards, with its
// own polling + owner gate.

const POLL_MS = 30_000;

export function AgentKpiView({ role }: { role: string }) {
  const workspace = useWorkspace();
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
      <p className="text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
    );
  }

  if (loading && !data) {
    return <div className="py-12 text-center text-sm text-zinc-400">Loading KPIs…</div>;
  }
  if (err && !data) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
        Couldn&apos;t load KPIs ({err}).
      </div>
    );
  }
  if (!data) return null;

  const headline = data.headline ?? [];
  const tiers = data.tiers ?? [];
  const postureTierKey = tiers[0]?.key;
  const postureTier = tiers[0];
  const restTiers = tiers.slice(1);
  const primaryOutcome = headline[1] ?? null;

  return (
    <div>
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {postureTier && <PostureCard cards={postureTier.cards} />}
        {primaryOutcome && <KpiCard card={primaryOutcome} />}
      </section>

      {postureTier && postureTier.cards.length > 0 && postureTierKey && (
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
