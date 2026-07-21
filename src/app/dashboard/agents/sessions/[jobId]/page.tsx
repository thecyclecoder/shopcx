"use client";

import { Suspense, useEffect, useState } from "react";
import { errText } from "@/lib/error-text";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";
import type { SessionChecklistItem } from "@/lib/agent-jobs";

// box-session-transparency Phase 3 — the per-job after-the-fact session-review page. A permalink for
// ONE agent_jobs row: who ran (persona) · what spec/kind · the preserved session_checklist (full plan,
// not collapsed) · session_note (the last live verb) · log_tail (the raw terminal tail) · verdict
// (status / error) · grade (1–10 + reasoning + graded_by). So a human can audit HOW the agent worked
// after the fact — not just its terminal chip. Pairs with the grading loop (the grader's reasoning
// cites the checklist). Backed by GET /api/developer/agents/sessions/[jobId]; reached from the
// per-agent panel's "view session →" link.

interface SessionGrade {
  grade: number | null;
  reasoning: string | null;
  gradedBy: string;
  createdAt: string;
}
interface SessionPayload {
  id: string;
  kind: string;
  specSlug: string | null;
  status: string;
  prUrl: string | null;
  prNumber: number | null;
  createdAt: string;
  updatedAt: string;
  logTail: string | null;
  error: string | null;
  sessionChecklist: SessionChecklistItem[] | null;
  sessionNote: string | null;
  grade: SessionGrade | null;
}

const STATUS_CHIP: Record<string, string> = {
  completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  merged: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  needs_attention: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  needs_input: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  needs_approval: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  queued: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  building: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
};

const STATUS_GLYPH: Record<SessionChecklistItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  done: "●",
};
const STATUS_GLYPH_CLS: Record<SessionChecklistItem["status"], string> = {
  pending: "text-zinc-400 dark:text-zinc-500",
  in_progress: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
};
const STATUS_ROW_CLS: Record<SessionChecklistItem["status"], string> = {
  pending: "text-zinc-500 dark:text-zinc-400",
  in_progress: "font-medium text-zinc-800 dark:text-zinc-100",
  done: "text-zinc-600 dark:text-zinc-300",
};

function fmtAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function gradeColor(n: number): string {
  if (n >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (n >= 7) return "text-zinc-700 dark:text-zinc-200";
  if (n >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function SessionDetail() {
  const params = useParams<{ jobId: string }>();
  const jobId = params.jobId;
  const workspace = useWorkspace();
  const [data, setData] = useState<SessionPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    let alive = true;
    fetch(`/api/developer/agents/sessions/${encodeURIComponent(jobId)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((d: SessionPayload) => {
        if (alive) setData(d);
      })
      .catch((e) => {
        if (alive) setErr(errText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [jobId, workspace.role]);

  if (workspace.role !== "owner") {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-12 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">Owner-only view.</p>
      </div>
    );
  }

  if (loading) {
    return <div className="py-12 text-center text-sm text-zinc-400">Loading session…</div>;
  }
  if (err || !data) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-12 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">Couldn&apos;t load the session.</p>
        {err && <p className="mt-1 text-[12px] text-zinc-400">{err}</p>}
      </div>
    );
  }

  const persona = getPersona(data.kind);
  const statusCls = STATUS_CHIP[data.status] ?? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";
  const checklist = data.sessionChecklist ?? [];
  const note = (data.sessionNote ?? "").trim();
  const done = checklist.filter((i) => i.status === "done").length;

  return (
    <div className="space-y-6">
      {/* Header — who ran (persona) + the kind + spec + status + when */}
      <div className="flex flex-wrap items-center gap-4">
        <PersonaAvatar persona={persona} size={56} />
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            {persona.name}
            <span className="text-base font-normal text-zinc-400">· {persona.role}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-zinc-500 dark:text-zinc-400">
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${statusCls}`}>{data.status}</span>
            <span className="font-mono text-zinc-400">{data.kind}</span>
            {data.specSlug && (
              <>
                <span>·</span>
                <Link
                  href={`/dashboard/roadmap/${data.specSlug}`}
                  className="font-mono text-zinc-600 underline decoration-dotted underline-offset-2 hover:text-indigo-600 dark:text-zinc-300 dark:hover:text-indigo-400"
                >
                  {data.specSlug}
                </Link>
              </>
            )}
            <span>·</span>
            <span title={fmtAt(data.createdAt)}>started {fmtAt(data.createdAt)}</span>
            {data.updatedAt !== data.createdAt && (
              <>
                <span>·</span>
                <span title={fmtAt(data.updatedAt)}>last update {fmtAt(data.updatedAt)}</span>
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-1 text-[12px]">
          {data.prUrl && (
            <a
              href={data.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:underline dark:text-indigo-400"
            >
              PR #{data.prNumber} →
            </a>
          )}
          <Link
            href={`/dashboard/agents/${encodeURIComponent(data.kind)}`}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            ← {persona.name}&apos;s profile
          </Link>
        </div>
      </div>

      {/* The grade card — what the grader scored + the reasoning that cites the checklist */}
      {data.grade && (
        <section className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Grade</h2>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className={`text-3xl font-semibold ${data.grade.grade != null ? gradeColor(data.grade.grade) : "text-zinc-300"}`}>
              {data.grade.grade != null ? data.grade.grade : "—"}
              <span className="text-sm font-normal text-zinc-400">/10</span>
            </span>
            <span className="text-[12px] text-zinc-400">
              by <span className="font-mono">{data.grade.gradedBy}</span> · {fmtAt(data.grade.createdAt)}
            </span>
          </div>
          {data.grade.reasoning && (
            <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-200">{data.grade.reasoning}</p>
          )}
        </section>
      )}

      {/* The plan — the full session_checklist, expanded, so a reader sees HOW the agent worked */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          Plan
          <span className="text-zinc-300 dark:text-zinc-600">·</span>
          <span className="font-normal tabular-nums text-zinc-400">
            {done}/{checklist.length} done
          </span>
        </h2>
        {note && (
          <p className="mb-2 text-[12px] italic text-zinc-600 dark:text-zinc-300">{note}</p>
        )}
        {checklist.length === 0 ? (
          <p className="text-[12px] text-zinc-400">
            No checklist was streamed — a pre-Phase-1 row, or the agent never emitted a TodoWrite event.
          </p>
        ) : (
          <ul className="space-y-1 rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[13px] dark:border-zinc-800 dark:bg-zinc-900">
            {checklist.map((it, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={`shrink-0 ${STATUS_GLYPH_CLS[it.status]}`} aria-label={it.status}>
                  {STATUS_GLYPH[it.status]}
                </span>
                <span className={`min-w-0 ${STATUS_ROW_CLS[it.status]}`}>
                  <span className="block">{it.step}</span>
                  {it.note && (
                    <span className="block text-[11px] italic text-zinc-500 dark:text-zinc-400">{it.note}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The verdict — error (if any) + the raw log_tail the worker writes on conclusion */}
      {data.error && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Error</h2>
          <pre className="overflow-auto whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50/60 px-3 py-2 text-[12px] leading-snug text-red-900 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
            {data.error}
          </pre>
        </section>
      )}
      {data.logTail && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Log tail</h2>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 font-mono text-[11px] leading-snug text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
            {data.logTail}
          </pre>
        </section>
      )}
    </div>
  );
}

export default function SessionReviewPage() {
  // useParams needs a Suspense boundary under cacheComponents.
  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-[12px] text-zinc-400">
        <Link href="/dashboard/agents" className="hover:text-zinc-700 dark:hover:text-zinc-200">
          Agents
        </Link>
        <span>/</span>
        <span className="text-zinc-500 dark:text-zinc-300">session</span>
      </div>
      <Suspense fallback={<div className="py-12 text-center text-sm text-zinc-400">Loading…</div>}>
        <SessionDetail />
      </Suspense>
    </div>
  );
}
