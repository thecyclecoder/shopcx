"use client";

// box-agent-model-tiers (Phase 4): one agent's current model tier + governed change history, on its
// profile. Reads GET /api/developer/agents/model-tier?kind=. "Model: {tier}" is the resolved tier the
// box passes as --model (null = the Max default — no flag). A pending proposal links to the routed
// inbox where the supervisor decides it with one tap (this card is read-only).
import { useEffect, useState } from "react";
import Link from "next/link";

interface ModelTierData {
  kind: string;
  current: {
    model_tier: string | null;
    proposed_by: string | null;
    approved_by: string | null;
    updated_at: string;
  } | null;
  history: {
    jobId: string;
    jobStatus: string;
    actionStatus: string | null;
    summary: string | null;
    created_at: string;
  }[];
}

const TIER_LABEL = (t: string | null) => t ?? "Max default";

export function ModelTierCard({ kind }: { kind: string }) {
  const [data, setData] = useState<ModelTierData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch(`/api/developer/agents/model-tier?kind=${encodeURIComponent(kind)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: ModelTierData) => live && setData(d))
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [kind]);

  const tier = data?.current?.model_tier ?? null;
  const pending = (data?.history ?? []).find((h) => h.jobStatus === "needs_approval" || h.actionStatus === "pending");
  const settled = (data?.history ?? []).filter((h) => h !== pending);

  return (
    <div className="mt-6">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Model</h3>
      <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        {loading ? (
          <p className="text-[12px] text-zinc-400">Loading…</p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-sm font-semibold text-zinc-800 dark:text-zinc-200">{TIER_LABEL(tier)}</span>
              {!tier && <span className="text-[11px] text-zinc-400">— inherits the Max-plan default (no --model)</span>}
            </div>
            {data?.current && (
              <p className="mt-1 text-[11px] text-zinc-400">
                {data.current.approved_by ? `approved by ${data.current.approved_by}` : "unset"}
                {data.current.proposed_by ? ` · proposed by ${data.current.proposed_by}` : ""}
              </p>
            )}

            {pending && (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="text-[12px] font-medium text-amber-800 dark:text-amber-300">Change awaiting approval</p>
                <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">{pending.summary}</p>
                <Link
                  href="/dashboard/agents/ceo"
                  className="mt-1 inline-block text-[11px] font-medium text-amber-700 underline hover:text-amber-900 dark:text-amber-400"
                >
                  Decide it in the inbox →
                </Link>
              </div>
            )}

            {settled.length > 0 && (
              <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Change history</p>
                <ul className="space-y-1">
                  {settled.slice(0, 6).map((h) => (
                    <li key={h.jobId} className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-zinc-500 dark:text-zinc-400">{h.summary ?? "(change)"}</span>
                      <span className="shrink-0 font-mono text-[10px] text-zinc-400">{h.actionStatus ?? h.jobStatus}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
