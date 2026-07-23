"use client";

import { useCallback, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useBoxLive } from "@/lib/use-box-live";
import { routedInboxHref } from "@/lib/agents/inbox";
import type { AgentJob, JobStatus } from "@/lib/agent-jobs";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

const LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting…",
  building: "Planning…",
  needs_input: "Needs input",
  needs_approval: "Approve branches",
  queued_resume: "Authoring…",
  blocked_on_usage: "Paused · usage",
  completed: "Planned ✓",
  merged: "Merged ✓",
  failed: "Failed",
  needs_attention: "Needs attention",
};

const CHIP: Record<JobStatus, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  claimed: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  building: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  needs_input: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  needs_approval: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  queued_resume: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  blocked_on_usage: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  merged: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  needs_attention: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

export default function PlanButton({
  goalSlug,
  initialJob,
  goalStatus,
}: {
  goalSlug: string;
  initialJob: AgentJob | null;
  // director-proposed-goals (Phase 2): a `proposed` goal is inert — it can't be decomposed until the CEO
  // greenlights it, so the Plan control is replaced by an "awaiting greenlight" note (and the API rejects it).
  goalStatus?: "proposed" | "greenlit" | "complete";
}) {
  const workspace = useWorkspace();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [busy, setBusy] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/plan?goalSlug=${encodeURIComponent(goalSlug)}`);
      if (res.ok) setJob((await res.json()).job);
    } catch {
      /* transient — keep polling */
    }
  }, [goalSlug]);

  const active = !!job && ACTIVE.includes(job.status);
  // roadmap-box-broadcast: was a 4s poll while the plan job is active. Now event-driven via useBoxLive —
  // refetch this job on any agent_jobs change (only while active), with a 10s backstop for safety.
  useBoxLive(poll, { enabled: active, backstopMs: 10_000 });
  const chip = job ? (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CHIP[job.status]}`}>{LABEL[job.status]}</span>
  ) : null;
  const prLink = job?.pr_url ? (
    <a href={job.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">PR ↗</a>
  ) : null;

  // A proposed goal awaits the CEO's greenlight before it can be decomposed (director-proposed-goals Phase 2).
  // Surface the inert state instead of a Plan control — greenlight happens in the Agents inbox, not here.
  if (goalStatus === "proposed") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50/40 px-2.5 py-2 text-[11px] leading-snug text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
        <span className="font-medium">⏳ Proposed — awaiting your greenlight.</span> Greenlight this goal in the Agents
        inbox; Pia can decompose it once it&apos;s activated.
      </div>
    );
  }

  if (workspace.role !== "owner") {
    return chip ? <div className="flex items-center gap-2">{chip}{prLink}</div> : null;
  }

  async function plan() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/roadmap/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalSlug }),
      });
      const d = await res.json();
      if (d.job) setJob(d.job);
    } finally {
      setBusy(false);
    }
  }

  const needsApproval = job?.status === "needs_approval";
  const pending = (job?.pending_actions || []).filter((a) => a.status === "pending");

  return (
    <div className="w-full">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {chip}
          {prLink}
        </div>
        {!active && (
          <button
            type="button"
            onClick={plan}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Run the planner: gap-analyze this goal against the brain and propose a milestone → spec tree for your approval"
          >
            {busy ? "…" : job ? "Re-plan" : "Plan goal"}
          </button>
        )}
      </div>

      {/* approval-routing-engine Phase 4: the proposed branches are approved/declined per-branch in the
          routed inbox (the single source) — owner + parent + intent render inline there. */}
      {needsApproval && pending.length > 0 && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 text-left text-[11px] leading-snug dark:border-amber-900/40 dark:bg-amber-950/20">
          <span className="font-medium text-amber-800 dark:text-amber-300">
            {pending.length} proposed branch{pending.length === 1 ? "" : "es"} await your approval.
          </span>{" "}
          <a href={routedInboxHref()} className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            Approve the branches in the Agents inbox →
          </a>
        </div>
      )}

      {job && !active && (job.pending_actions || []).length > 0 && (
        <div className="mt-2 space-y-1 text-[11px]">
          {(job.pending_actions || []).map((a) => (
            <div key={a.id} className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
              <span>{a.status === "done" || a.status === "approved" ? "✅" : a.status === "declined" ? "❌" : "•"}</span>
              <span className="truncate">{a.summary}</span>
            </div>
          ))}
        </div>
      )}
      {job?.error && <div className="mt-1 text-[11px] text-rose-600">{job.error}</div>}
    </div>
  );
}
