"use client";

// Growth → Media Buyer shadow-reviews dashboard tile (media-buyer-shadow-mode Phase 3).
//
// Lists recent `<verb>_shadow` director_activity rows that lack a media_buyer_shadow_reviews row
// (verbs: media_buyer_promoted_winner_shadow · _paused_loser_shadow · _replenished_test_cohort_shadow
// · _fatigue_replenish_triggered_shadow). Ordered by director_activity.created_at desc.
//
// The reviewer picks concur / dissent / undecided per action; the POST hits the sibling route
// which upserts on director_activity_id (idempotent). Once every open action is reviewed, the
// evidence is in place to flip the policy from `shadow` to `armed` via the separate flip surface.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface OpenShadowAction {
  director_activity_id: string;
  action_kind: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

type Verdict = "concur" | "dissent" | "undecided";

const VERB_LABEL: Record<string, string> = {
  media_buyer_promoted_winner_shadow: "Promote winner",
  media_buyer_paused_loser_shadow: "Pause loser",
  media_buyer_replenished_test_cohort_shadow: "Replenish test cohort",
  media_buyer_fatigue_replenish_triggered_shadow: "Fatigue replenish",
};

function verbLabel(kind: string): string {
  return VERB_LABEL[kind] || kind;
}

export default function ShadowReviewsPage() {
  const workspace = useWorkspace();
  const [rows, setRows] = useState<OpenShadowAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [rationaleById, setRationaleById] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/growth/media-buyer/shadow-reviews?workspaceId=${workspace.id}`);
      if (!res.ok) {
        setError(`Failed to load shadow actions (${res.status})`);
        return;
      }
      const body = (await res.json()) as { open?: OpenShadowAction[] };
      setRows(body.open ?? []);
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = useCallback(
    async (row: OpenShadowAction, verdict: Verdict) => {
      setSubmittingId(row.director_activity_id);
      const rationale = rationaleById[row.director_activity_id]?.trim() || null;
      try {
        const res = await fetch(`/api/growth/media-buyer/shadow-reviews?workspaceId=${workspace.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            director_activity_id: row.director_activity_id,
            verdict,
            rationale,
          }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          alert(`Review failed: ${j?.error ?? res.statusText}`);
          return;
        }
        // Optimistically drop the reviewed row from the open list — a re-fetch keeps state honest.
        setRows((prev) => prev.filter((r) => r.director_activity_id !== row.director_activity_id));
      } finally {
        setSubmittingId(null);
      }
    },
    [rationaleById, workspace.id],
  );

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Shadow reviews</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Every Media Buyer plan action recorded in shadow mode — concur to endorse for the armed flip, dissent to block.
          </p>
        </div>
        <Link href="/dashboard/marketing/ads" className="text-sm text-indigo-600 hover:underline">
          ← Ads
        </Link>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No open shadow actions. Every Media Buyer pass on shadow mode will surface here.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const meta = (r.metadata ?? {}) as Record<string, unknown>;
            const sourceMetaAdId = typeof meta.source_meta_ad_id === "string" ? meta.source_meta_ad_id : null;
            const roas = typeof meta.roas === "number" ? meta.roas : null;
            const policyVersionId = typeof meta.policy_version_id === "string" ? meta.policy_version_id : null;
            const isSubmitting = submittingId === r.director_activity_id;
            return (
              <li key={r.director_activity_id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {verbLabel(r.action_kind)}
                      {sourceMetaAdId ? <span className="ml-2 font-mono text-xs text-zinc-500">{sourceMetaAdId}</span> : null}
                    </h3>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{r.reason ?? "(no reason recorded)"}</p>
                    <p className="mt-2 text-xs text-zinc-500">
                      {roas != null ? <>ROAS {roas.toFixed(2)} · </> : null}
                      {policyVersionId ? <>policy {policyVersionId.slice(0, 8)} · </> : null}
                      {new Date(r.created_at).toLocaleString()}
                    </p>
                  </div>
                </div>
                <div className="mt-3">
                  <textarea
                    placeholder="Rationale (optional)"
                    value={rationaleById[r.director_activity_id] ?? ""}
                    onChange={(e) => setRationaleById((prev) => ({ ...prev, [r.director_activity_id]: e.target.value }))}
                    className="mb-2 w-full rounded border border-zinc-200 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => submit(r, "concur")}
                      className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      Concur
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => submit(r, "dissent")}
                      className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50"
                    >
                      Dissent
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => submit(r, "undecided")}
                      className="rounded bg-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-zinc-300 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-200"
                    >
                      Undecided
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
