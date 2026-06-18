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

  return (
    <div className="flex items-center gap-2">
      {chip}
      {prLink}
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
  );
}
