"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface Todo {
  id: string;
  group_id: string;
  action_type: string;
  summary: string;
  status: string;
  urgency: string;
  confidence: number | null;
  payload: Record<string, unknown>;
  context_what_happened: string | null;
  context_what_we_propose: string | null;
  execution_result: Record<string, unknown> | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_role: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  can_approve?: boolean;
}

interface Detail {
  todo: Todo;
  group: Todo[];
  approver_names: Record<string, string>;
  ticket: { id: string; subject: string | null; status: string; escalation_reason: string | null } | null;
  customer: { first_name: string | null; last_name: string | null; email: string | null } | null;
  ltv_cents: number;
  messages: Array<{ id: string; direction: string; visibility: string; author_type: string; body: string; created_at: string }>;
  role: string;
}

const ACTION_BADGE: Record<string, string> = {
  customer_reply: "bg-teal-100 text-teal-700",
  customer_action: "bg-indigo-100 text-indigo-700",
  ticket_close: "bg-zinc-100 text-zinc-600",
  ticket_analysis_rescore: "bg-amber-100 text-amber-700",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-blue-100 text-blue-700",
  executed: "bg-emerald-100 text-emerald-700",
  rejected: "bg-rose-100 text-rose-700",
  superseded: "bg-zinc-100 text-zinc-500",
  failed: "bg-red-100 text-red-700",
};

export default function TodoDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showConvo, setShowConvo] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/todos/${id}`)
      .then((r) => r.json())
      .then((d) => setData(d.error ? null : d))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(todoId: string, action: "approve" | "reject") {
    let reason: string | undefined;
    if (action === "reject") {
      reason = window.prompt("Reason for rejecting (optional):") || undefined;
    }
    setBusy(todoId);
    try {
      const res = await fetch(`/api/todos/${todoId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: action === "reject" ? JSON.stringify({ reason }) : undefined,
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        alert(e.error || `Failed to ${action}`);
      }
      load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="p-6 text-sm text-zinc-400">Loading…</div>;
  if (!data) return <div className="p-6 text-sm text-zinc-400">Todo not found.</div>;

  const { todo, group, ticket, customer, ltv_cents, messages, approver_names } = data;
  const customerName = customer
    ? `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || customer.email || "Customer"
    : "—";

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <Link href="/dashboard/tickets/todos" className="text-sm text-zinc-400 hover:text-zinc-600">
        ← Back to To Do
      </Link>

      {/* Header */}
      <div className="mt-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{customerName}</h1>
          <span className="text-sm text-zinc-500">LTV ${(ltv_cents / 100).toFixed(2)}</span>
        </div>
        {ticket && (
          <div className="mt-1 text-sm text-zinc-500">
            <Link href={`/dashboard/tickets/${ticket.id}`} className="hover:underline">
              {ticket.subject || "(no subject)"}
            </Link>
            <span className="ml-2 text-xs text-zinc-400">#{ticket.id.slice(0, 8)}</span>
            {ticket.escalation_reason && (
              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                {ticket.escalation_reason}
              </span>
            )}
          </div>
        )}
      </div>

      {/* What happened */}
      {todo.context_what_happened && (
        <Section title="What happened">
          <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{todo.context_what_happened}</p>
        </Section>
      )}

      {/* What we propose */}
      {todo.context_what_we_propose && (
        <Section title="What we propose">
          <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{todo.context_what_we_propose}</p>
        </Section>
      )}

      {/* Linked todos */}
      <Section title={`Proposed actions (${group.length})`}>
        <div className="space-y-3">
          {group.map((g) => (
            <div key={g.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_BADGE[g.action_type] || ACTION_BADGE.ticket_close}`}>
                    {g.action_type.replace(/_/g, " ")}
                  </span>
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">{g.summary}</span>
                </div>
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_BADGE[g.status] || STATUS_BADGE.pending}`}>
                  {g.status}
                </span>
              </div>

              <ActionPreview todo={g} />

              {g.status === "pending" ? (
                g.can_approve ? (
                  <div className="mt-3 flex gap-2">
                    <button
                      disabled={busy === g.id}
                      onClick={() => act(g.id, "approve")}
                      className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      disabled={busy === g.id}
                      onClick={() => act(g.id, "reject")}
                      className="rounded border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      Reject
                    </button>
                  </div>
                ) : (
                  <div className="mt-3 inline-flex items-center rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-500 dark:bg-zinc-800">
                    Needs owner access to approve
                  </div>
                )
              ) : (
                <div className="mt-2 text-xs text-zinc-400">
                  {g.status === "approved" || g.status === "executed"
                    ? `Approved by ${g.approval_role || ""} ${approver_names[g.approved_by || ""] || ""} ${g.approved_at ? "· " + new Date(g.approved_at).toLocaleString() : ""}`
                    : g.status === "rejected"
                      ? `Rejected by ${approver_names[g.rejected_by || ""] || ""}${g.reject_reason ? ` — ${g.reject_reason}` : ""}`
                      : null}
                  {g.execution_result?.pr_url ? (
                    <PrCard result={g.execution_result} />
                  ) : null}
                  {g.execution_result?.error ? (
                    <div className="mt-1 text-rose-500">Error: {String(g.execution_result.error)}</div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      {/* Conversation appendix */}
      <Section title="Conversation">
        <button onClick={() => setShowConvo((s) => !s)} className="text-sm text-zinc-500 hover:text-zinc-700">
          {showConvo ? "Hide" : "Show"} full conversation ({messages.length} messages)
        </button>
        {showConvo && (
          <div className="mt-3 space-y-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded p-2 text-sm ${m.direction === "inbound" ? "bg-zinc-100 dark:bg-zinc-800" : "bg-teal-50 dark:bg-teal-900/20"}`}
              >
                <div className="mb-1 text-xs text-zinc-400">
                  {m.author_type} · {m.direction} · {new Date(m.created_at).toLocaleString()}
                  {m.visibility === "internal" && <span className="ml-1 text-amber-500">(internal)</span>}
                </div>
                <div className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-300" dangerouslySetInnerHTML={{ __html: m.body }} />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">{title}</h2>
      {children}
    </div>
  );
}

function PrCard({ result }: { result: Record<string, unknown> }) {
  const url = String(result.pr_url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 inline-flex items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
    >
      {result.branch ? `${result.branch} → ` : ""}Open PR in GitHub ↗
      {result.merged_at ? <span className="text-emerald-500">merged</span> : null}
    </a>
  );
}

/** Action-specific preview block. */
function ActionPreview({ todo }: { todo: Todo }) {
  const p = todo.payload || {};
  if (todo.action_type === "customer_reply") {
    const html = String((p as { body_html?: string }).body_html || "");
    return (
      <div className="mt-2 rounded border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-1 text-xs text-zinc-400">Customer will see:</div>
        <div className="text-zinc-700 dark:text-zinc-300" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  }
  if (todo.action_type === "customer_action") {
    const pa = p as { actions?: Array<Record<string, unknown>>; diff_summary?: string; kind?: string };
    return (
      <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/40">
        {pa.diff_summary && <div className="text-zinc-700 dark:text-zinc-300">{pa.diff_summary}</div>}
        <pre className="mt-1 overflow-x-auto text-xs text-zinc-500">{JSON.stringify(pa.actions || pa, null, 2)}</pre>
      </div>
    );
  }
  if (todo.action_type === "ticket_analysis_rescore") {
    const pa = p as { score?: number; summary?: string };
    return (
      <div className="mt-2 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900/40">
        <div className="text-zinc-700 dark:text-zinc-300">New score: {pa.score}/10</div>
        {pa.summary && <div className="mt-1 text-xs text-zinc-500">{pa.summary}</div>}
      </div>
    );
  }
  return null;
}
