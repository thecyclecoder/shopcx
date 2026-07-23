"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { useBoxLive } from "@/lib/use-box-live";
import { routedInboxHref } from "@/lib/agents/inbox";
import type { AgentJob, JobStatus, PendingFold } from "@/lib/agent-jobs";
import type { Phase, SpecStatus } from "@/lib/brain-roadmap";
import { SessionChecklist } from "@/components/agents/session-checklist";

const ACTIVE: JobStatus[] = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"];

// build-recover-pr-create: the exact `error` the worker stamps when a build succeeds + pushes its branch
// but `gh pr create` fails. Mirrors PR_CREATE_FAILED_ERROR in roadmap-actions.ts (client-safe copy — that
// module is server-only). Such a needs_attention job is RECOVERABLE: the work is done + pushed, so the card
// offers "Create PR" (re-open the PR) as primary, with Rebuild demoted to a labeled discard-and-redo.
const PR_CREATE_FAILED_ERROR = "branch pushed but PR creation failed";

// Status emoji for a Blocked-by entry (spec-blockers) — matches the brain's phaseEmoji + the board legend.
const PHASE_EMOJI: Record<Phase, string> = { planned: "⏳", in_progress: "🚧", shipped: "✅", rejected: "❌" };

type Blocker = { slug: string; title: string; status: Phase; cleared: boolean };

export default function BuildButton({ slug, initialJob, specStatus, initialFold, blockedBy }: { slug: string; initialJob: AgentJob | null; specStatus: SpecStatus; initialFold?: PendingFold | null; blockedBy?: Blocker[] }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [job, setJob] = useState<AgentJob | null>(initialJob);
  const [fold, setFold] = useState<PendingFold | null>(initialFold ?? null);
  const [busy, setBusy] = useState(false);
  const [showAnswers, setShowAnswers] = useState(false);
  const [answerMap, setAnswerMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);
  const [showIssue, setShowIssue] = useState(false);
  const [issueText, setIssueText] = useState("");
  const [reporting, setReporting] = useState(false);
  const [issueNotice, setIssueNotice] = useState<string | null>(null);
  const [confirmVerify, setConfirmVerify] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoverNotice, setRecoverNotice] = useState<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/roadmap/build?slug=${encodeURIComponent(slug)}`);
      if (res.ok) {
        const d = await res.json();
        // build-card-lifecycle-timeline Phase 2: when the job status FLIPS during a poll, kick a server
        // refresh so the parent-rendered LifecycleTimeline picks up the new pill text. Without this, the
        // local state advances but the timeline (server-rendered on the page) sticks on its first-paint
        // status — observed as "Building…" lingering after the build flipped to needs_approval.
        setJob((prev) => {
          if (d.job && prev && d.job.status !== prev.status) router.refresh();
          return d.job;
        });
        setFold(d.fold ?? null);
      }
    } catch {
      /* transient — keep polling */
    }
  }, [slug, router]);

  // A pending/folding spec is being retired by a batch fold-build (fold-build-batching) — its own build
  // job no longer maps 1:1 to a PR, so show "Folding…" and keep polling until the fold row clears.
  const folding = !!fold && (fold.status === "pending" || fold.status === "folding");

  const active = !!job && ACTIVE.includes(job.status);
  // roadmap-box-broadcast: was a 4s poll while the build job is live OR a fold is in flight. Now
  // event-driven via useBoxLive — refetch this build on any agent_jobs change (while active/folding),
  // with a 10s backstop for safety.
  useBoxLive(poll, { enabled: active || folding, backstopMs: 10_000 });

  // spec-blockers: a spec with any uncleared Blocked-by prerequisite can't be built yet. The server gate
  // (queueRoadmapBuild) is the real enforcement; this disables the button + names what must ship first.
  const blockers = blockedBy ?? [];
  const uncleared = blockers.filter((b) => !b.cleared);
  const blocked = uncleared.length > 0;
  const blockedTooltip = blocked ? `Build is blocked — ship first: ${uncleared.map((b) => b.slug).join(", ")}` : undefined;

  // build-card-lifecycle-timeline Phase 2: the floating status pill is REPLACED by the per-card
  // LifecycleTimeline rendered at the parent (the board Card / detail sidebar). BuildButton no longer
  // owns the chip — the PR link is the only inline crumb left here, since the timeline pill carries
  // the human label ("Building…" / "Built · needs approval" / "Folding…").
  const prLink = job?.pr_url ? (
    <a href={job.pr_url} target="_blank" rel="noreferrer" className="text-[11px] text-teal-600 hover:underline">
      PR ↗
    </a>
  ) : null;

  if (workspace.role !== "owner") {
    return prLink ? <div className="flex items-center gap-2">{prLink}</div> : null;
  }

  async function build() {
    if (busy || blocked) return; // server gate refuses anyway; don't even fire the request
    setBusy(true);
    try {
      // "Build all" (build-all-phases-chain): chain the phases — queue the first ⏳ phase tagged
      // chain_phases so the next ⏳ phase auto-queues on each merge, until all phases ✅ (no clicks between).
      // A single/zero-phase spec degrades to a normal whole-spec build server-side.
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, chainPhases: true }),
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

  // build-recover-pr-create: re-open the PR for an already-pushed build branch (the build succeeded but
  // `gh pr create` failed). The server re-validates branch-exists-on-origin + idempotently adopts an
  // existing PR; on success the job flips to `completed` with the recovered PR attached.
  async function createPr() {
    if (!job || recovering) return;
    setRecovering(true);
    setRecoverNotice(null);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.id, recoverPr: true }),
      });
      const d = await res.json();
      if (res.ok && d.job) {
        setJob(d.job);
        router.refresh();
      } else {
        setRecoverNotice(d.error ? `Couldn't open the PR: ${d.error}` : "Couldn't open the PR — please try again.");
      }
    } catch {
      setRecoverNotice("Couldn't open the PR — please try again.");
    } finally {
      setRecovering(false);
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
    setIssueNotice(null);
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, instructions: `Fix this reported issue — do ONLY this, do not rebuild the whole spec:\n\n${issueText.trim()}` }),
      });
      const d = await res.json();
      if (!res.ok) {
        setIssueNotice(d.error ? `Couldn't queue your issue: ${d.error}` : "Couldn't queue your issue — please try again.");
        return;
      }
      if (d.queuedBehindActive && d.job) {
        // A build is already running for this spec — the issue was enqueued as a distinct follow-up build
        // (never dropped). Keep the dialog open with a clear confirmation; the new job runs after the
        // current one finishes (the box serializes per-spec).
        setIssueText("");
        setIssueNotice(`Issue queued as build ${String(d.job.id).slice(0, 8)} — it'll run after the current build finishes.`);
        router.refresh();
      } else if (d.job && !d.alreadyActive) {
        // Fresh fix-build queued.
        setJob(d.job);
        setShowIssue(false);
        setIssueText("");
        router.refresh();
      } else {
        // alreadyActive with no new job (a plain coalesce) — do NOT clear+close as a phantom success.
        setIssueNotice("A build is already running — your issue couldn't be queued. Please try again once it finishes.");
      }
    } catch {
      setIssueNotice("Couldn't queue your issue — please try again.");
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
  // build-recover-pr-create: a needs_attention job whose branch pushed but PR-create failed = recoverable.
  // The server re-checks branch-exists-on-origin; this is the cheap card-side gate to offer Create PR.
  const recoverable =
    job?.kind === "build" && job.status === "needs_attention" && job.error === PR_CREATE_FAILED_ERROR && !!job.spec_branch;
  // spec-goal-branch-pm-flow fix: the manual squash-merge only surfaces once the spec is in_testing — i.e.
  // ALL phases have accumulated on the branch (gated in applyInTestingOverlay). A single built phase (P1)
  // whose build completed + opened the PR must NOT surface the merge action while later phases are still
  // planned/building. (Auto-merge additionally requires spec-test + security green via isSpecPromoteEligible.)
  const canMerge = !!job?.pr_number && job.status === "completed" && !merged && specStatus === "in_testing";
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
        {/* build-card-lifecycle-timeline Phase 2: the status pill moved to the LifecycleTimeline on the
            parent card. We still surface the PR link inline (and the fold-PR link while folding) as a
            useful jump-off; the live status text now lives ATTACHED to the timeline's current node. */}
        {folding ? foldPrLink : prLink}
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
      </div>
      {/* box-session-transparency Phase 2 — the active session's live TodoWrite mirror (compact one-line
          note + expand for the full checklist). Replaces the opaque "Building…" chip as the only signal
          of what the session is doing right now. Shown only on ACTIVE jobs so a completed/failed card
          doesn't carry a stale checklist; the runner streams these onto the job row, and the existing
          4s poll above re-renders as the agent ticks through its todos. */}
      {active && (job!.session_note || (job!.session_checklist && job!.session_checklist.length)) && (
        <SessionChecklist note={job!.session_note} checklist={job!.session_checklist} />
      )}
      {/* spec-blockers: a "🔒 Blocked by …" chip listing each prerequisite + its status. Shown whenever a
          prerequisite is still uncleared, on a not-yet-shipped spec. Cleared blockers render ✅. */}
      {blocked && specStatus !== "shipped" && (
        <div
          className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1.5 text-[11px] leading-snug text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300"
          title={blockedTooltip}
        >
          <span className="font-medium">🔒 Blocked by</span>{" "}
          {blockers.map((b, i) => (
            <span key={b.slug}>
              {i > 0 && ", "}
              <a href={`/dashboard/roadmap/${b.slug}`} className="underline decoration-dotted hover:text-amber-900 dark:hover:text-amber-200">
                {b.slug}
              </a>{" "}
              {b.cleared ? "✅" : PHASE_EMOJI[b.status]}
            </span>
          ))}
        </div>
      )}
      {/* build-recover-pr-create: a build that finished + pushed its branch but failed to open the PR.
          Primary = Create PR (recover the completed build); Rebuild is demoted to a labeled discard-and-redo
          fallback (use only if the branch is bad). Shown regardless of specStatus — the work is done. */}
      {recoverable ? (
        <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/70 px-2 py-2 text-left dark:border-amber-900/40 dark:bg-amber-950/20">
          <p className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
            This build finished and pushed its branch (<code>{job!.spec_branch}</code>), but opening the PR failed.
            Recover it — no code is re-run.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={createPr}
              disabled={recovering}
              className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {recovering ? "Opening PR…" : "Create PR"}
            </button>
            <button
              type="button"
              onClick={build}
              disabled={busy || recovering}
              title="Discards the completed, pushed build and rebuilds from scratch — only if the branch is bad."
              className="rounded-md border border-zinc-200 px-3 py-2 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
            >
              {busy ? "…" : "Rebuild (discard)"}
            </button>
          </div>
          {recoverNotice && <p className="text-[11px] text-rose-600 dark:text-rose-400">{recoverNotice}</p>}
        </div>
      ) : (
        /* Build / Rebuild gets its own full-width row. Disabled while blocked (server gate also refuses). */
        !active && specStatus !== "shipped" && (
          <div className="mt-2">
            <button
              type="button"
              onClick={build}
              disabled={busy || blocked}
              title={blockedTooltip}
              className="w-full rounded-md bg-indigo-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "…" : blocked ? "🔒 Blocked" : job ? "Rebuild" : "Build all"}
            </button>
          </div>
        )
      )}
      {/* Report issue + Mark verified & archive get their own full-width row so they
          aren't jammed in with the status chip / PR / build controls above. Report issue is
          available even while a build is active — a scoped fix is enqueued behind it, never dropped. */}
      <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setShowIssue((v) => !v)}
            className="flex-1 rounded-md border border-zinc-200 px-3 py-2 text-[12px] font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            {showIssue ? "Cancel" : "Report issue"}
          </button>
          {canVerify && (
            <button
              type="button"
              onClick={() => setConfirmVerify((v) => !v)}
              className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-[12px] font-medium text-white hover:bg-emerald-700"
              title="Optional manual fold — a passing machine spec-test auto-folds this; use this to fold + archive it now"
            >
              {confirmVerify ? "Cancel" : "Fold to brain now"}
            </button>
          )}
      </div>
      {canVerify && confirmVerify && (
        <div className="mt-2 space-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 text-left dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <p className="text-[11px] text-emerald-800 dark:text-emerald-300">
            Optional — a passing machine spec-test auto-folds this; this just does it now. Queues a fold-build that folds
            the spec into the brain, appends an archive entry, and deletes <code>specs/{slug}.md</code> — opening a PR for
            you to merge. Nothing is lost (git-recoverable; knowledge lives in the brain).
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
      {/* approval-routing-engine Phase 4: the approval is decided in the routed inbox (the single source),
          not on a standalone spec card. The investigation + Approve/Decline render inline there. */}
      {needsApproval && (job!.pending_actions || []).some((a) => a.status === "pending") && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 text-left text-[11px] leading-snug dark:border-amber-900/40 dark:bg-amber-950/20">
          <span className="font-medium text-amber-800 dark:text-amber-300">Needs your approval before continuing.</span>{" "}
          <a href={routedInboxHref()} className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
            Review &amp; approve in the Agents inbox →
          </a>
        </div>
      )}
      {showIssue && (
        <div className="mt-2 space-y-2 rounded-md border border-zinc-200 bg-zinc-50/60 p-2 text-left dark:border-zinc-700 dark:bg-zinc-900">
          <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
            {active
              ? "Describe the issue or fix — a build is running, so this queues a follow-up fix-build that runs next (the spec stays as-is):"
              : "Describe the issue or fix — queues a scoped fix-build (the spec stays as-is):"}
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
          {issueNotice && <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{issueNotice}</p>}
        </div>
      )}
    </div>
  );
}
