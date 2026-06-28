"use client";

import { useState } from "react";

/**
 * spec-test-request-fix-inline-author-and-approve Phase 2 — the in-card affordance the spec-test page
 * renders for a regressed origin spec ONCE its inline fix has been authored.
 *
 * Replaces the old terminal "Fix queued — building" copy on `ProposeFixButton`'s `queued` state with the
 * fix's LIVE state right on the origin's card: its slug + a state pill (`building` / `needs input` /
 * `ready to approve` / `ready to merge` / `merged` / `failed`), plus — once the fix build has produced a
 * reviewable result with a gated action — an inline Approve button. The owner author → watches → approves,
 * never leaving `/dashboard/developer/spec-tests`.
 *
 * The Approve button posts `{ jobId, actionId, decision: 'approve' }` to the canonical
 * POST /api/roadmap/approve route (the same path the dashboard's role-inbox uses), so there is NO bespoke
 * merge code on the spec-test surface — Phase 3's hook completes the loop end-to-end. When there is no
 * gated action ready yet, the button does NOT render (a build that auto-merges has nothing to approve).
 *
 * Fix linkage is resolved by `regression_of_slug = origin` (typed column on `public.specs`), NOT a
 * hand-typed slug — a renamed fix slug still surfaces.
 */
export interface FixCardProps {
  /** The fix spec's slug, derived from the typed `regression_of_slug = origin` linkage. */
  fixSlug: string;
  /** The live state label the card displays — derived server-side from the agent_jobs row + spec status. */
  state: FixCardState;
  /** Compact mode — used inline on the per-spec card list. */
  compact?: boolean;
  /** Optional gated-action handle: when present, an Approve button posts to /api/roadmap/approve. */
  approval?: { jobId: string; actionId: string };
}

export type FixCardState =
  | "building" // queued / claimed / building / queued_resume / blocked_on_usage
  | "needs_input" // owner-answerable open question on the build
  | "needs_approval" // a gated action is pending — Approve renders
  | "ready_to_merge" // PR open, awaiting auto-merge / squash-merge
  | "merged" // shipped — origin re-test should run shortly
  | "failed"; // failed / needs_attention

const STATE_LABEL: Record<FixCardState, string> = {
  building: "building",
  needs_input: "needs input",
  needs_approval: "ready to approve",
  ready_to_merge: "ready to merge",
  merged: "merged",
  failed: "failed",
};

const STATE_CLASS: Record<FixCardState, string> = {
  building: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  needs_input: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  needs_approval: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  ready_to_merge: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  merged: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-zinc-200 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300",
};

export default function FixCard({ fixSlug, state, compact, approval }: FixCardProps) {
  const [busy, setBusy] = useState<"approve" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);

  async function approve() {
    if (!approval) return;
    setBusy("approve");
    setError(null);
    try {
      const res = await fetch("/api/roadmap/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: approval.jobId, actionId: approval.actionId, decision: "approve" }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setApproved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not approve");
    } finally {
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`${compact ? "text-[11px]" : "text-xs"} text-zinc-500 dark:text-zinc-400`}>
        Fix <code>{fixSlug}</code>
      </span>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
          compact ? "text-[10px]" : "text-[11px]"
        } font-medium ${STATE_CLASS[state]}`}
      >
        {STATE_LABEL[state]}
      </span>
      {approval && !approved && (
        <button
          type="button"
          onClick={approve}
          disabled={busy !== null}
          className={`rounded-md bg-emerald-600 font-medium text-white hover:bg-emerald-700 disabled:opacity-50 ${
            compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs"
          }`}
          title="Approve the fix's gated action — same path the canonical approval inbox uses"
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
      )}
      {approval && approved && (
        <span className={`text-emerald-600 dark:text-emerald-400 ${compact ? "text-[11px]" : "text-xs"}`}>
          Approved — building.
        </span>
      )}
      {error && <span className="text-[11px] text-rose-500">{error}</span>}
    </span>
  );
}
