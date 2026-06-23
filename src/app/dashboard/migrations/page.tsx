"use client";

/**
 * Migrations monitor — "what's stuck?" for Appstle→internal migrations.
 *
 * North star: a `failed` row is a renewal at risk. This page surfaces failed +
 * pending audits with their failing checks so they get fixed before the next
 * renewal. See specs/appstle-pricing-heal-and-migration-monitor.md § Phase 3.
 */

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { routedInboxHref } from "@/lib/agents/inbox";

interface Check { key: string; ok: boolean; detail?: string }
interface FixAction { id: string; fix_kind: string; summary: string; preview?: string; status: string; result?: string }
interface FixQuestion { id: string; q: string }
interface FixInfo {
  jobId: string;
  status: string; // queued|building|needs_input|needs_approval|completed|failed|needs_attention
  diagnosis: string | null;
  error: string | null;
  questions: FixQuestion[];
  actions: FixAction[];
}
interface Audit {
  id: string;
  subscription_id: string;
  appstle_contract_id: string | null;
  internal_contract_id: string | null;
  is_recovery: boolean;
  status: string;
  checks: Check[];
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  fix?: FixInfo;
}
interface Resp {
  counts: { passed: number; pending: number; failed: number; total: number };
  atRisk: Audit[];
  recentPassed: Audit[];
}

export default function MigrationsPage() {
  const workspace = useWorkspace();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const isOwner = workspace.role === "owner";

  const load = useCallback(() => {
    return fetch("/api/migrations")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => setData(null));
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [workspace.id, load]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-zinc-900">Migrations</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Appstle→internal migration health. A <strong>failed</strong> row is a renewal at risk — fix it before the next bill.
      </p>

      {loading ? (
        <div className="mt-6 rounded-xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">Loading…</div>
      ) : !data ? (
        <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">Couldn’t load migrations.</div>
      ) : (
        <>
          {/* Counts */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Total" value={data.counts.total} tone="zinc" />
            <Stat label="Passed" value={data.counts.passed} tone="emerald" />
            <Stat label="Pending" value={data.counts.pending} tone="amber" />
            <Stat label="Failed" value={data.counts.failed} tone="rose" />
          </div>

          {/* At-risk */}
          <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Needs attention</h2>
          {data.atRisk.length === 0 ? (
            <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm font-medium text-emerald-800">
              ✅ Nothing stuck — every migration passed.
            </div>
          ) : (
            <div className="mt-3 space-y-3">
              {data.atRisk.map((a) => (
                <AuditCard key={a.id} a={a} isOwner={isOwner} onChange={load} />
              ))}
            </div>
          )}

          {/* Recent passed */}
          {data.recentPassed.length > 0 && (
            <>
              <h2 className="mt-8 text-sm font-semibold uppercase tracking-wider text-zinc-500">Recently passed</h2>
              <div className="mt-3 space-y-2">
                {data.recentPassed.map((a) => (
                  <div key={a.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-2.5 text-sm">
                    <span className="font-mono text-xs text-zinc-600">{a.subscription_id.slice(0, 8)} · {a.internal_contract_id}</span>
                    <span className="flex items-center gap-2 text-zinc-500">
                      {a.is_recovery && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">Recovery</span>}
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">Passed</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "zinc" | "emerald" | "amber" | "rose" }) {
  const tones: Record<string, string> = {
    zinc: "border-zinc-200 bg-white text-zinc-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-semibold uppercase tracking-wider opacity-80">{label}</div>
    </div>
  );
}

function AuditCard({ a, isOwner, onChange }: { a: Audit; isOwner: boolean; onChange: () => Promise<unknown> }) {
  const failed = (a.checks || []).filter((c) => !c.ok);
  const isFailed = a.status === "failed";
  return (
    <article className={`rounded-xl border p-4 ${isFailed ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-xs text-zinc-700">
          sub {a.subscription_id.slice(0, 8)} · {a.appstle_contract_id} → {a.internal_contract_id}
        </div>
        <div className="flex items-center gap-2">
          {a.is_recovery && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-700">Recovery</span>}
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${isFailed ? "bg-rose-200 text-rose-800" : "bg-amber-200 text-amber-800"}`}>
            {a.status} · retry {a.retry_count}
          </span>
        </div>
      </div>
      <ul className="mt-3 space-y-1">
        {(a.checks || []).map((c) => (
          <li key={c.key} className="flex items-start gap-2 text-xs">
            <span>{c.ok ? "✅" : "❌"}</span>
            <span className={c.ok ? "text-zinc-600" : "font-medium text-rose-800"}>
              {c.key}
              {c.detail ? <span className="font-normal text-zinc-500"> — {c.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      {failed.length > 0 && <p className="mt-2 text-xs text-rose-700">{failed.length} check(s) failing.</p>}
      {a.fix && <FixPanel fix={a.fix} isOwner={isOwner} onChange={onChange} />}
    </article>
  );
}

// The migration-fix box agent's diagnosis + (when it proposed a fix) a read-only view of the proposed
// typed fix. The Approve/Decline ORIGINATES in the routed Agents inbox now (approval-routing-engine
// Phase 4 — "one inbox, no orphans"), not a standalone card here: migration_fix is plain approve/decline,
// so the inbox renders it inline and POST /api/roadmap/approve drives the SAME runMigrationFixJob resume
// (isApprovalResume → executes the typed fix + re-runs verifyMigration) whichever surface decided it. The
// needs_input answer flow stays (it's an answer, not an approval). See docs/brain/specs/migration-fix-agent.md.
function FixPanel({ fix, isOwner, onChange }: { fix: FixInfo; isOwner: boolean; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const diagnosis = fix.diagnosis || fix.error;
  const label =
    fix.status === "needs_input" ? "🤖 needs your answer"
    : fix.status === "needs_approval" ? "🤖 fix proposed — awaiting approval"
    : fix.status === "completed" ? (fix.error ? "🤖 needs a human" : "🤖 worked")
    : fix.status === "queued" || fix.status === "building" || fix.status === "queued_resume" ? "🤖 diagnosing…"
    : fix.status === "needs_attention" || fix.status === "failed" ? "🤖 attention needed"
    : `🤖 ${fix.status}`;

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");

  // Owner answers the box's plain judgment question inline → reuse POST /api/roadmap/answer
  // ({jobId, answers:[{id,q,answer}]}) → the job flips queued_resume and the box resumes WITH the
  // answer to propose a concrete gated fix. See docs/brain/specs/migration-fix-human-input.md.
  const send = async () => {
    const payload = fix.questions.map((q) => ({ id: q.id, q: q.q, answer: (answers[q.id] || "").trim() }));
    if (note.trim()) payload.push({ id: "note", q: "Additional note", answer: note.trim() });
    if (payload.every((a) => !a.answer)) {
      setErr("Type an answer first.");
      return;
    }
    setBusy("send");
    setErr(null);
    try {
      const res = await fetch("/api/roadmap/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: fix.jobId, answers: payload }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || `Failed (${res.status})`);
      } else {
        setAnswers({});
        setNote("");
        await onChange();
      }
    } catch {
      setErr("Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-indigo-200 bg-white/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">{label}</span>
      </div>
      {diagnosis && <p className="mt-1.5 whitespace-pre-wrap text-xs text-zinc-700">{diagnosis}</p>}
      {fix.status === "needs_input" && (
        isOwner ? (
          <div className="mt-2 space-y-2">
            {fix.questions.map((q) => (
              <div key={q.id}>
                <p className="text-xs font-medium text-zinc-800">{q.q}</p>
                <input
                  type="text"
                  value={answers[q.id] || ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  placeholder="Type your answer…"
                  disabled={!!busy}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
                />
              </div>
            ))}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Note (optional)</p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything else the fix should know…"
                rows={2}
                disabled={!!busy}
                className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
              />
            </div>
            <button
              disabled={!!busy}
              onClick={send}
              className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy === "send" ? "Sending…" : "Send"}
            </button>
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-400">Owner answer required.</p>
        )
      )}
      {fix.status === "needs_approval" && fix.actions.length > 0 && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-2">
            {fix.actions.map((act) => (
              <li key={act.id} className="rounded-md border border-zinc-200 bg-white p-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[10px] text-indigo-700">{act.fix_kind}</span>
                  <span className="font-medium text-zinc-800">{act.summary}</span>
                </div>
                {act.preview && <p className="mt-1 whitespace-pre-wrap text-[11px] text-zinc-500">{act.preview}</p>}
                {act.status !== "pending" && <p className="mt-1 text-[11px] text-zinc-500">{act.status}{act.result ? ` — ${act.result}` : ""}</p>}
              </li>
            ))}
          </ul>
          {/* approval-routing-engine Phase 4 — the proposed fix is approved in the single routed Agents inbox,
              not a standalone card here. The inbox renders this plain approve/decline inline; the executor is unchanged. */}
          {isOwner ? (
            <a href={routedInboxHref()} className="inline-block text-[11px] font-medium text-indigo-600 hover:text-indigo-700">
              Review &amp; approve in the Agents inbox →
            </a>
          ) : (
            <p className="text-[11px] text-zinc-400">Owner approval required.</p>
          )}
        </div>
      )}
      {err && <p className="mt-1.5 text-[11px] text-rose-600">{err}</p>}
    </div>
  );
}
