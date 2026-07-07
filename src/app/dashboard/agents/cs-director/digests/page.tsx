"use client";

// /dashboard/agents/cs-director/digests — the founder's read + reply surface for the CS Director's
// weekly storyline digest (Phase 2 of docs/brain/specs/cs-director-storyline-digests-to-founder-
// with-bidirectional-reply.md). Renders the LATEST cs_director_digests row for the workspace and,
// per storyline, a small action panel (Widen leash · Tighten leash · Add policy · Add rule) that
// posts to /api/developer/agents/cs-director/digests/[id]/reply.
//
// Client component — reads via a GET endpoint on mount (the parent layout.tsx wraps this in
// Suspense for the cacheComponents rule).

import { useCallback, useEffect, useState } from "react";

type StorylineKind = "early_warning" | "precedent_call" | "per_ticket_escalation";
type ProposedActionType = "widen_leash" | "tighten_leash" | "add_policy" | "add_rule" | null;

interface Storyline {
  kind: StorylineKind;
  title: string;
  evidence: string;
  proposed_action: { type: ProposedActionType; payload?: Record<string, unknown> };
}

interface DigestRow {
  id: string;
  digest_period_start: string;
  digest_period_end: string;
  storylines: Storyline[];
  created_at: string;
  ceo_replied_at: string | null;
  ceo_reply_action: Record<string, unknown> | null;
}

type ReplyAction = "widen_leash" | "tighten_leash" | "add_policy" | "add_rule";

const ACTION_LABEL: Record<ReplyAction, string> = {
  widen_leash: "Widen leash",
  tighten_leash: "Tighten leash",
  add_policy: "Add policy",
  add_rule: "Add rule",
};

const KIND_LABEL: Record<StorylineKind, string> = {
  early_warning: "Early warning",
  precedent_call: "Precedent call",
  per_ticket_escalation: "Per-ticket escalation",
};

export default function CsDirectorDigestsPage() {
  const [loading, setLoading] = useState(true);
  const [digest, setDigest] = useState<DigestRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [busyAction, setBusyAction] = useState<ReplyAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/developer/agents/cs-director/digests/latest", { cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `Failed to load digest (${res.status})`);
        setDigest(null);
      } else {
        const j = (await res.json()) as { digest: DigestRow | null };
        setDigest(j.digest);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load digest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reply = useCallback(
    async (storyline_index: number, action: ReplyAction) => {
      if (!digest) return;
      setBusyIndex(storyline_index);
      setBusyAction(action);
      setToast(null);
      try {
        const res = await fetch(`/api/developer/agents/cs-director/digests/${digest.id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storyline_index, action }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
          stamp_reason?: string;
        };
        if (!res.ok || !j.ok) {
          setToast(j.error ? `${j.error}${j.detail ? `: ${j.detail}` : ""}` : `Action failed (${res.status})`);
        } else if (j.stamp_reason) {
          setToast(`Action applied — ${j.stamp_reason}`);
        } else {
          setToast(`${ACTION_LABEL[action]} — applied.`);
        }
        await load();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusyIndex(null);
        setBusyAction(null);
      }
    },
    [digest, load],
  );

  if (loading) {
    return <div className="p-6 text-sm text-neutral-500">Loading CS Director digest…</div>;
  }
  if (error) {
    return <div className="p-6 text-sm text-red-600">Error: {error}</div>;
  }
  if (!digest) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-medium text-neutral-900">CS Director digests</h1>
        <p className="mt-2 text-sm text-neutral-600">
          No digests yet. The weekly composer runs Monday 14:00 UTC and posts the CS Director&rsquo;s
          storyline recap here.
        </p>
      </div>
    );
  }

  const replied = !!digest.ceo_replied_at;

  return (
    <div className="p-6 max-w-4xl">
      <header className="mb-4">
        <h1 className="text-lg font-medium text-neutral-900">CS Director digest</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Week of {new Date(digest.digest_period_start).toLocaleDateString()} —{" "}
          {new Date(digest.digest_period_end).toLocaleDateString()} · composed{" "}
          {new Date(digest.created_at).toLocaleString()}
        </p>
        {replied ? (
          <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            Replied {digest.ceo_replied_at ? new Date(digest.ceo_replied_at).toLocaleString() : ""} — one action per digest.
          </div>
        ) : null}
      </header>

      {toast ? (
        <div className="mb-4 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-800">
          {toast}
        </div>
      ) : null}

      {digest.storylines.length === 0 ? (
        <p className="text-sm text-neutral-500">Quiet week — no storylines.</p>
      ) : (
        <ul className="space-y-4">
          {digest.storylines.map((s, i) => (
            <li key={i} className="rounded-md border border-neutral-200 p-4">
              <div className="flex items-center justify-between">
                <span className="rounded bg-neutral-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-600">
                  {KIND_LABEL[s.kind] ?? s.kind}
                </span>
                {s.proposed_action?.type ? (
                  <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                    Proposed: {ACTION_LABEL[s.proposed_action.type as ReplyAction] ?? s.proposed_action.type}
                  </span>
                ) : null}
              </div>
              <h2 className="mt-2 text-sm font-medium text-neutral-900">{s.title}</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">{s.evidence}</p>

              <div className="mt-3 flex flex-wrap gap-2">
                {(["widen_leash", "tighten_leash", "add_policy", "add_rule"] as ReplyAction[]).map((action) => {
                  const isBusy = busyIndex === i && busyAction === action;
                  return (
                    <button
                      key={action}
                      type="button"
                      onClick={() => void reply(i, action)}
                      disabled={replied || busyIndex !== null}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isBusy ? "…" : ACTION_LABEL[action]}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
