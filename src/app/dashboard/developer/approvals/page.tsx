"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import type { ApprovalFeedItem, FeedStatus } from "@/lib/agents/approvals-feed";

// Approvals activity feed (developer/approvals) — the ONE place every approval surfaces: the live
// queue the CEO must still decide (escalated → actionable Approve/Decline inline) AND the ledger of
// everything already decided (mostly the autonomous Platform director's auto-approvals → read-only
// logs). Mobile-friendly cards, newest-first. Backed by GET /api/developer/approvals.
// See docs/brain/dashboard/approvals.md.

function elapsed(iso: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

const STATUS_STYLE: Record<FeedStatus, { label: string; cls: string }> = {
  awaiting: { label: "Awaiting", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  declined: { label: "Declined", cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" },
  escalated: { label: "Escalated", cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" },
};

type Filter = "needs-ceo" | "all" | "approved" | "declined";

// ── A single meta chip (spec / goal / milestone / phase) ────────────────────────
function MetaChip({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className="shrink-0 font-medium uppercase tracking-wide text-zinc-400">{label}</span>
      <span className={`truncate ${accent ?? "text-zinc-600 dark:text-zinc-300"}`}>{value}</span>
    </span>
  );
}

// ── One approval card ───────────────────────────────────────────────────────────
function ApprovalCard({ item, onActed }: { item: ApprovalFeedItem; onActed: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const status = STATUS_STYLE[item.status];

  const decide = async (actionId: string, decision: "approve" | "decline") => {
    if (!item.jobId) return;
    setBusy(`${actionId}:${decision}`);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, actionId, decision }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onActed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setBusy(null);
    }
  };

  const dismiss = async () => {
    setDismissing(true);
    setError(null);
    try {
      const res = await fetch("/api/developer/agents/inbox/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onActed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setDismissing(false);
    }
  };

  const summary = item.summary?.trim() || null;
  const long = summary != null && summary.length > 220;

  return (
    <li
      className={`rounded-xl border p-3.5 shadow-sm sm:p-4 ${
        item.escalated
          ? "border-amber-300 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-950/15"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
      }`}
    >
      {/* Header: status · type · autonomy · time */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${status.cls}`}>
          {item.escalated ? "Needs CEO" : status.label}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {item.typeLabel}
        </span>
        {item.autonomous && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
            autonomous
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{elapsed(item.createdAt)}</span>
      </div>

      {/* Title */}
      <h3 className="mt-2 text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{item.title}</h3>

      {/* Spec / goal / milestone / phase chips */}
      {(item.spec || item.goal || item.milestone || item.phase) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.spec && (
            <MetaChip label="Spec" value={item.spec.title || item.spec.slug} accent="text-zinc-700 dark:text-zinc-200" />
          )}
          {item.goal && <MetaChip label="Goal" value={item.goal.title} accent="text-indigo-600 dark:text-indigo-300" />}
          {item.milestone && <MetaChip label="Milestone" value={item.milestone} />}
          {item.phase && <MetaChip label="Phase" value={item.phase} accent="text-amber-700 dark:text-amber-300" />}
        </div>
      )}

      {/* Routing line: who raised → routed / decided */}
      <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        {item.raisedBy && (
          <>
            from <span className="font-medium text-zinc-700 dark:text-zinc-200">{item.raisedBy.name}</span>
            <span className="text-zinc-400"> ({item.raisedBy.role})</span>
          </>
        )}
        {item.source === "pending" && item.routedTo && (
          <>
            {" → routed to "}
            <span className="font-medium text-zinc-700 dark:text-zinc-200">{item.routedTo.name}</span>
          </>
        )}
        {item.source === "decision" && item.decidedByLabel && (
          <>
            {" · decided by "}
            <span className="font-medium text-zinc-700 dark:text-zinc-200">{item.decidedByLabel}</span>
          </>
        )}
      </p>

      {/* Reasoning / investigation — collapsible (it can be a long audit trail) */}
      {summary && (
        <div className="mt-2">
          <p
            className={`whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-300 ${
              !expanded && long ? "line-clamp-3" : ""
            }`}
          >
            {summary}
          </p>
          {long && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-0.5 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* Inline decision affordances — only for an escalated-to-human request with pending actions */}
      {item.actionable &&
        item.actions.map((a) => (
          <div
            key={a.id}
            className="mt-2.5 rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950/40"
          >
            {a.summary && <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200">{a.summary}</div>}
            {(a.specOwner || a.specParent) && (
              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                {a.specOwner && (
                  <>
                    owner <span className="font-medium text-violet-600 dark:text-violet-400">{a.specOwner}</span>
                  </>
                )}
                {a.specParent && <> · ↳ {a.specParent}</>}
              </div>
            )}
            {(a.preview || a.cmd) && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 font-sans text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
                {a.preview || (a.cmd ? `$ ${a.cmd}` : "")}
              </pre>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => decide(a.id, "approve")}
                disabled={busy !== null}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === `${a.id}:approve` ? "Approving…" : "Approve"}
              </button>
              <button
                onClick={() => decide(a.id, "decline")}
                disabled={busy !== null}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {busy === `${a.id}:decline` ? "Declining…" : "Decline"}
              </button>
            </div>
          </div>
        ))}

      {/* Footer: deep-link to the full surface (non-actionable parks) + Dismiss (pending only) */}
      {item.source === "pending" && (
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {item.deepLink && !item.actionable ? (
            <Link
              href={item.deepLink}
              className="text-[12px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              Open the full surface →
            </Link>
          ) : (
            <span />
          )}
          <button
            onClick={dismiss}
            disabled={dismissing || busy !== null}
            className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-200"
            title="Clear this from the queue (the underlying job is untouched)"
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      )}

      {error && <p className="mt-1.5 text-[11px] text-rose-500">{error}</p>}
    </li>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────
export default function ApprovalsPage() {
  const workspace = useWorkspace();
  const [items, setItems] = useState<ApprovalFeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const load = useCallback(async (quiet?: boolean) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch("/api/developer/approvals");
      if (!res.ok) throw new Error(String(res.status));
      const d: { items: ApprovalFeedItem[] } = await res.json();
      setItems(d.items);
      setErr(false);
    } catch {
      setErr(true);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (workspace.role !== "owner") return;
    // cut-internal-egress-pooler-and-spec-rpcs Phase 3: visibility-guard — a backgrounded tab
    // stops firing the ~15s approvals poll and refreshes on return-to-visible, so the routed
    // Agents inbox doesn't shed egress when the operator has flipped to another tab. Approvals
    // change on events, not routes, so deferring while hidden is safe. Mirrors the shipped
    // sidebar reduce-calls pattern (src/app/dashboard/sidebar.tsx:347).
    load();
    const runPoll = () => { if (document.visibilityState === "visible") load(true); };
    const onVisibility = () => { if (document.visibilityState === "visible") load(true); };
    const t = setInterval(runPoll, 15000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspace.role, load]);

  const counts = useMemo(() => {
    const all = items ?? [];
    return {
      needsCeo: all.filter((i) => i.escalated).length,
      pending: all.filter((i) => i.source === "pending").length,
      all: all.length,
    };
  }, [items]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (filter === "needs-ceo" && !i.escalated) return false;
      if (filter === "approved" && i.status !== "approved") return false;
      if (filter === "declined" && i.status !== "declined") return false;
      if (!needle) return true;
      return (
        i.title.toLowerCase().includes(needle) ||
        (i.summary ?? "").toLowerCase().includes(needle) ||
        (i.spec?.slug ?? "").toLowerCase().includes(needle) ||
        (i.goal?.title ?? "").toLowerCase().includes(needle) ||
        i.typeLabel.toLowerCase().includes(needle)
      );
    });
  }, [items, filter, q]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Approvals</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const FILTERS: { id: Filter; label: string; badge?: number }[] = [
    { id: "all", label: "All activity", badge: counts.all || undefined },
    { id: "needs-ceo", label: "Needs CEO", badge: counts.needsCeo || undefined },
    { id: "approved", label: "Approved" },
    { id: "declined", label: "Declined" },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Approvals</h1>
          <p className="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
            Every approval in one feed. Most are auto-approved by the autonomous director and logged here; the ones
            escalated to the CEO (Henry) carry the decision inline.
          </p>
        </div>
        {counts.needsCeo > 0 && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {counts.needsCeo} need{counts.needsCeo === 1 ? "s" : ""} CEO
          </span>
        )}
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                filter === f.id
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {f.label}
              {f.badge != null && (
                <span className="rounded-full bg-zinc-100 px-1.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                  {f.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-40 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        />
        <button
          onClick={() => load()}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {/* Feed */}
      <div className="mt-4">
        {loading && !items ? (
          <div className="py-16 text-center text-sm text-zinc-400">Loading approvals…</div>
        ) : err && !items ? (
          <div className="rounded-xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load approvals.
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-14 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
              {filter === "needs-ceo" ? "Nothing escalated to the CEO right now." : "No approvals yet."}
            </p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
              Every routed approve/decline lands here — autonomous director auto-approvals as logs, escalations to the
              CEO as actionable cards.
            </p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((i) => (
              <ApprovalCard key={`${i.source}:${i.id}`} item={i} onActed={() => load(true)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
