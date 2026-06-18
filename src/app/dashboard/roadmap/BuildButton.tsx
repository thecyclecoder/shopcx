"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { AgentJob, JobStatus } from "@/lib/agent-jobs";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "queued_resume"];

const LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting…",
  building: "Building…",
  needs_input: "Needs input",
  queued_resume: "Resuming…",
  completed: "Built",
  failed: "Failed",
  needs_attention: "Needs attention",
};

const CHIP: Record<JobStatus, string> = {
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  claimed: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  building: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  needs_input: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  queued_resume: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  needs_attention: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

export default function BuildButton({ slug, initialJob }: { slug: string; initialJob: AgentJob | null }) {
  const workspace = useWorkspace();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [busy, setBusy] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const [answerMap, setAnswerMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/build?slug=${encodeURIComponent(slug)}`);
      if (res.ok) setJob((await res.json()).job);
    } catch {
      /* transient — keep polling */
    }
  }, [slug]);

  // Poll while the job is live; stop on a terminal status.
  useEffect(() => {
    if (!job || !ACTIVE.includes(job.status)) return;
    timer.current = setInterval(poll, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [job, poll]);

  const active = !!job && ACTIVE.includes(job.status);

  const chip = job ? (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${CHIP[job.status]}`}>
      {LABEL[job.status]}
    </span>
  ) : null;
  const prLink = job?.pr_url ? (
    <a href={job.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">
      PR ↗
    </a>
  ) : null;

  if (workspace.role !== "owner") {
    return chip ? (
      <div className="flex items-center gap-2">
        {chip}
        {prLink}
      </div>
    ) : null;
  }

  async function build() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const d = await res.json();
      if (d.job) setJob(d.job);
    } catch {
      /* surfaced via no state change; user can retry */
    } finally {
      setBusy(false);
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

  const needsInput = job?.status === "needs_input";

  return (
    <div className="w-full">
      <div className="flex items-center justify-end gap-2">
        {chip}
        {prLink}
        {needsInput && (
          <button
            type="button"
            onClick={() => setShowAnswers((v) => !v)}
            className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700"
          >
            {showAnswers ? "Cancel" : "Answer"}
          </button>
        )}
        {!active && (
          <button
            type="button"
            onClick={build}
            disabled={busy}
            className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "…" : job ? "Rebuild" : "Build"}
          </button>
        )}
      </div>
      {needsInput && showAnswers && (
        <div className="mt-2 space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-2 text-left dark:border-indigo-900/40 dark:bg-indigo-950/20">
          {(job!.questions || []).map((q) => (
            <div key={q.id}>
              <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{q.q}</label>
              <textarea
                rows={2}
                value={answerMap[q.id] || ""}
                onChange={(e) => setAnswerMap((m) => ({ ...m, [q.id]: e.target.value }))}
                className="mt-1 w-full rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={submitAnswers}
            disabled={submitting}
            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Submit & resume"}
          </button>
        </div>
      )}
    </div>
  );
}
