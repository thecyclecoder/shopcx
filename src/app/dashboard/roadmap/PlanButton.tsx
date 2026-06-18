"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { AgentJob, JobStatus } from "@/lib/agent-jobs";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

const LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting…",
  building: "Planning…",
  needs_input: "Needs input",
  needs_approval: "Approve branches",
  queued_resume: "Authoring…",
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
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  merged: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  needs_attention: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

export default function PlanButton({ goalSlug, initialJob }: { goalSlug: string; initialJob: AgentJob | null }) {
  const workspace = useWorkspace();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/plan?goalSlug=${encodeURIComponent(goalSlug)}`);
      if (res.ok) setJob((await res.json()).job);
    } catch {
      /* transient — keep polling */
    }
  }, [goalSlug]);

  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    timer.current = setInterval(poll, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [job, poll]);

  const active = !!job && ACTIVE.includes(job.status);
  const chip = job ? (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CHIP[job.status]}`}>{LABEL[job.status]}</span>
  ) : null;
  const prLink = job?.pr_url ? (
    <a href={job.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">PR ↗</a>
  ) : null;

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

  async function decide(actionId: string, decision: "approve" | "decline") {
    if (!job || decidingId) return;
    setDecidingId(actionId);
    try {
      const res = await fetch("/api/roadmap/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, actionId, decision }),
      });
      const d = await res.json();
      if (d.job) setJob(d.job);
    } finally {
      setDecidingId(null);
    }
  }

  const proposed = (job?.pending_actions || []).filter((a) => a.type === "spec");
  const pending = proposed.filter((a) => a.status === "pending");
  const decided = proposed.filter((a) => a.status !== "pending");

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
            title="Decompose this goal into a milestone → spec tree (human-gated)"
          >
            {busy ? "…" : job ? "Re-plan" : "Plan"}
          </button>
        )}
      </div>

      {job?.status === "needs_approval" && proposed.length > 0 && (
        <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
            Proposed specs — approve the branches to pursue. Each approved branch gets authored + queued for build.
          </div>
          {pending.map((a) => (
            <div key={a.id} className="rounded border border-amber-100 bg-white p-2 dark:border-amber-900/30 dark:bg-zinc-900">
              <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200">{a.summary}</div>
              {a.preview && (
                <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{a.preview}</p>
              )}
              {a.specSlug && <code className="mt-1 block text-[10px] text-zinc-400">specs/{a.specSlug}.md</code>}
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => decide(a.id, "approve")} disabled={decidingId !== null} className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {decidingId === a.id ? "…" : "Approve"}
                </button>
                <button type="button" onClick={() => decide(a.id, "decline")} disabled={decidingId !== null} className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                  Decline
                </button>
              </div>
            </div>
          ))}
          {decided.length > 0 && (
            <div className="space-y-0.5 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {decided.map((a) => (
                <div key={a.id} className="flex items-center gap-1.5">
                  <span>{a.status === "approved" || a.status === "done" ? "✅" : "❌"}</span>
                  <span className="truncate">{a.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {job?.status === "failed" && job.error && (
        <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">{job.error}</p>
      )}
    </div>
  );
}
