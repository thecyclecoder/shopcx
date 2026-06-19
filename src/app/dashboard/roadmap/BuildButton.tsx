"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import type { AgentJob, JobStatus, PendingFold } from "@/lib/agent-jobs";
import type { Phase } from "@/lib/brain-roadmap";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

const LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  claimed: "Starting…",
  building: "Building…",
  needs_input: "Needs input",
  needs_approval: "Needs approval",
  queued_resume: "Resuming…",
  completed: "Built",
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

export default function BuildButton({ slug, initialJob, specStatus, initialFold }: { slug: string; initialJob: AgentJob | null; specStatus: Phase; initialFold?: PendingFold | null }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [fold, setFold] = useState<PendingFold | null>(initialFold ?? null);
  const [busy, setBusy] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const [answerMap, setAnswerMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [reporting, setReporting] = useState(false);
  const [confirmVerify, setConfirmVerify] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/build?slug=${encodeURIComponent(slug)}`);
      if (res.ok) {
        const d = await res.json();
        setJob(d.job);
        setFold(d.fold ?? null);
      }
    } catch {
      /* transient — keep polling */
    }
  }, [slug]);

  // A pending/folding spec is being retired by a batch fold-build (fold-build-batching) — its own build
  // job no longer maps 1:1 to a PR, so show "Folding…" and keep polling until the fold row clears.
  const folding = !!fold && (fold.status === "pending" || fold.status === "folding");

  // Poll while the job is live OR a fold is in flight; stop on a terminal state.
  useEffect(() => {
    if (!(job && ACTIVE.includes(job.status)) && !folding) return;
    timer.current = setInterval(poll, 4000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [job, folding, poll]);

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
      if (d.job) {
        setJob(d.job);
        // The job is now an active row; refresh the server board so the live overlay re-buckets this
        // card into "In progress" right away (instant feedback, well before the 4s poll), using real
        // DB state — not a client guess that could drift.
        router.refresh();
      }
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

  async function mergeJob() {
    if (!job?.pr_number || merging) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/branches/${job.pr_number}/merge`, { method: "POST" });
      if (res.ok) setMerged(true);
    } finally {
      setMerging(false);
    }
  }

  async function reportIssue() {
    if (reporting || !issueText.trim()) return;
    setReporting(true);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, instructions: `Fix this reported issue — do ONLY this, do not rebuild the whole spec:\n\n${issueText.trim()}` }),
      });
      const d = await res.json();
      if (d.job) {
        setJob(d.job);
        setShowIssue(false);
        setIssueText("");
        router.refresh();
      }
    } finally {
      setReporting(false);
    }
  }

  async function verify() {
    if (verifying) return;
    setVerifying(true);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, verify: true }),
      });
      const d = await res.json();
      if (d.job) {
        // Verify coalesces into a batch fold job — flip to "Folding…" immediately; poll refreshes it.
        setFold({ spec_slug: slug, status: "pending", job_id: d.job.id ?? null, foldJob: d.job });
        setConfirmVerify(false);
        router.refresh();
      }
    } finally {
      setVerifying(false);
    }
  }

  const needsInput = job?.status === "needs_input";
  const needsApproval = job?.status === "needs_approval";
  const canMerge = !!job?.pr_number && job.status === "completed" && !merged;
  // Verify is the owner-only "I tested it in prod" gate, offered only on shipped specs with no live build
  // and not already in a fold batch.
  const canVerify = specStatus === "shipped" && !active && !merged && !folding;
  const foldPrLink = fold?.foldJob?.pr_url ? (
    <a href={fold.foldJob.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">
      fold PR ↗
    </a>
  ) : null;

  return (
    <div className="w-full">
      <div className="flex items-center justify-end gap-2">
        {folding ? (
          <>
            <span
              className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
              title="Verified — being retired into the brain by a batch fold-build (one PR folds all verified specs)"
            >
              Folding…
            </span>
            {foldPrLink}
          </>
        ) : (
          <>
            {chip}
            {prLink}
          </>
        )}
        {merged && <span className="text-[11px] text-emerald-600">merged ✓</span>}
        {canMerge && (
          <button
            type="button"
            onClick={mergeJob}
            disabled={merging}
            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {merging ? "Merging…" : "Squash & merge"}
          </button>
        )}
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
            onClick={() => setShowIssue((v) => !v)}
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            {showIssue ? "Cancel" : "Report issue"}
          </button>
        )}
        {canVerify && (
          <button
            type="button"
            onClick={() => setConfirmVerify((v) => !v)}
            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700"
            title="Owner gate: confirm this shipped feature works in production, then fold + archive its spec"
          >
            {confirmVerify ? "Cancel" : "Mark verified & archive"}
          </button>
        )}
        {!active && specStatus !== "shipped" && (
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
      {canVerify && confirmVerify && (
        <div className="mt-2 space-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 text-left dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <p className="text-[11px] text-emerald-800 dark:text-emerald-300">
            You&apos;ve confirmed this works in production. This queues a fold-build that folds the spec into the brain,
            appends an archive entry, and deletes <code>specs/{slug}.md</code> — opening a PR for you to merge. Nothing is
            lost (git-recoverable; knowledge lives in the brain).
          </p>
          <button
            type="button"
            onClick={verify}
            disabled={verifying}
            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {verifying ? "Queuing…" : "Verify & queue fold-build"}
          </button>
        </div>
      )}
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
      {needsApproval && (job!.pending_actions || []).some((a) => a.status === "pending") && (
        <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 text-left dark:border-amber-900/40 dark:bg-amber-950/20">
          <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">Needs your approval before continuing:</div>
          {(job!.pending_actions || []).filter((a) => a.status === "pending").map((a) => (
            <div key={a.id} className="rounded border border-amber-100 bg-white p-2 dark:border-amber-900/30 dark:bg-zinc-900">
              <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200">{a.summary}</div>
              {(a.preview || a.cmd) && (
                <pre className="mt-1 max-h-32 overflow-auto rounded bg-zinc-100 p-1.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{a.preview || a.cmd}</pre>
              )}
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => decide(a.id, "approve")} disabled={approvingId !== null} className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {approvingId === a.id ? "…" : "Approve & apply"}
                </button>
                <button type="button" onClick={() => decide(a.id, "decline")} disabled={approvingId !== null} className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showIssue && !active && (
        <div className="mt-2 space-y-2 rounded-md border border-zinc-200 bg-zinc-50/60 p-2 text-left dark:border-zinc-700 dark:bg-zinc-900">
          <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
            Describe the issue or fix — queues a scoped fix-build (the spec stays as-is):
          </label>
          <textarea
            rows={2}
            value={issueText}
            onChange={(e) => setIssueText(e.target.value)}
            className="w-full rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            type="button"
            onClick={reportIssue}
            disabled={reporting || !issueText.trim()}
            className="rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {reporting ? "Queuing…" : "Queue fix"}
          </button>
        </div>
      )}
    </div>
  );
}
