"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { AgentJob, JobStatus } from "@/lib/agent-jobs";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

const LABEL: Record<JobStatus, string> = {
  queued: "Plan queued",
  claimed: "Starting…",
  building: "Planning…",
  needs_input: "Needs input",
  needs_approval: "Approve branches",
  queued_resume: "Authoring specs…",
  completed: "Planned",
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

/**
 * Owner-only "Plan" / "Re-plan" for a goal. Queues a kind='plan' agent_jobs row (the goal
 * slug rides in spec_slug — one active plan per goal). When the planner pauses at
 * needs_approval, this renders one Approve/Decline card per proposed spec branch (reusing
 * /api/roadmap/approve). See docs/brain/specs/goal-decomposition-engine.md.
 */
export default function PlanButton({ goalSlug, initialJob }: { goalSlug: string; initialJob: AgentJob | null }) {
  const workspace = useWorkspace();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [showAnswers, setShowAnswers] = useState(false);
  const [answerMap, setAnswerMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/build?slug=${encodeURIComponent(goalSlug)}`);
      if (res.ok) setJob((await res.json()).job);
    } catch {
      /* transient */
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
  if (workspace.role !== "owner") {
    return job ? (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CHIP[job.status]}`}>{LABEL[job.status]}</span>
    ) : null;
  }

  async function plan() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/roadmap/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: goalSlug }),
      });
      const d = await res.json();
      if (d.job) setJob(d.job);
    } finally {
      setBusy(false);
    }
  }

  async function decide(actionId: string, decision: "approve" | "decline") {
    if (!job || approvingId) return;
    setApprovingId(actionId);
    try {
      const res = await fetch("/api/roadmap/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, actionId, decision }),
      });
      const d = await res.json();
      if (d.job) setJob(d.job);
    } finally {
      setApprovingId(null);
    }
  }

  async function submitAnswers() {
    if (!job || submitting) return;
    setSubmitting(true);
    try {
      const answers = (job.questions || []).map((q) => ({ id: q.id, q: q.q, answer: answerMap[q.id] || "" }));
      const res = await fetch("/api/roadmap/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, answers }),
      });
      const d = await res.json();
      if (d.job) {
        setJob(d.job);
        setShowAnswers(false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const chip = job ? (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CHIP[job.status]}`}>{LABEL[job.status]}</span>
  ) : null;
  const needsApproval = job?.status === "needs_approval";
  const needsInput = job?.status === "needs_input";
  const decided = (job?.pending_actions || []).filter((a) => a.status === "approved" || a.status === "declined");

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        {chip}
        {job?.pr_url && (
          <a href={job.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">PR ↗</a>
        )}
        {!active && (
          <button
            type="button"
            onClick={plan}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            title="Decompose this goal into a proposed milestone → spec tree (human-gated)"
          >
            {busy ? "…" : job ? "Re-plan" : "Plan"}
          </button>
        )}
        {needsInput && (
          <button type="button" onClick={() => setShowAnswers((v) => !v)} className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700">
            {showAnswers ? "Cancel" : "Answer"}
          </button>
        )}
      </div>

      {needsInput && showAnswers && (
        <div className="mt-2 space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-2 text-left dark:border-indigo-900/40 dark:bg-indigo-950/20">
          {(job!.questions || []).map((q) => (
            <div key={q.id}>
              <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{q.q}</label>
              <textarea rows={2} value={answerMap[q.id] || ""} onChange={(e) => setAnswerMap((m) => ({ ...m, [q.id]: e.target.value }))} className="mt-1 w-full rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900" />
            </div>
          ))}
          <button type="button" onClick={submitAnswers} disabled={submitting} className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
            {submitting ? "Sending…" : "Submit & resume"}
          </button>
        </div>
      )}

      {needsApproval && (job!.pending_actions || []).length > 0 && (
        <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 text-left dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">Proposed spec branches — approve the ones to author + build:</div>
          {(job!.pending_actions || []).map((a) => (
            <div key={a.id} className="rounded border border-amber-100 bg-white p-2 dark:border-amber-900/30 dark:bg-zinc-900">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200">{a.summary}</div>
                {a.status !== "pending" && (
                  <span className={`text-[10px] font-medium ${a.status === "approved" ? "text-emerald-600" : "text-rose-500"}`}>{a.status}</span>
                )}
              </div>
              {a.preview && (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{a.preview}</pre>
              )}
              {a.status === "pending" && (
                <div className="mt-1.5 flex gap-2">
                  <button type="button" onClick={() => decide(a.id, "approve")} disabled={approvingId !== null} className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    {approvingId === a.id ? "…" : "Approve"}
                  </button>
                  <button type="button" onClick={() => decide(a.id, "decline")} disabled={approvingId !== null} className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                    Decline
                  </button>
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-amber-700/80 dark:text-amber-300/70">
            Once every branch has a decision, the worker authors the approved specs, wikilinks them into this goal, and queues their builds. Declined branches are recorded so re-plan won&apos;t re-propose them.
          </p>
        </div>
      )}

      {job?.status === "completed" && decided.length > 0 && (
        <p className="mt-2 text-[11px] text-zinc-400">
          Last plan: {decided.filter((a) => a.status === "approved").length} approved · {decided.filter((a) => a.status === "declined").length} declined.
        </p>
      )}
    </div>
  );
}
