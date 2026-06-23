"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { getPersona } from "@/lib/agents/personas";
import { PersonaAvatar, StatusBadge } from "@/components/agents/persona-chip";
import { OrgTree } from "@/components/agents/org-tree";
import { BoardChannel } from "@/components/agents/board-channel";
import { XpCard, type DirectorXp } from "@/components/agents/xp-card";
import { INBOX_TABS, APPROVAL_REQUEST_TYPE, type InboxTab, type InboxItem, type InboxPayload } from "@/lib/agents/inbox";

// Agents hub (agents-hub-role-inboxes spec) — the owner-only org-chart surface.
// Left: CEO → Directors → Workers, read from functions/+goals/ via brain-roadmap.
// Right: the selected role's three-tab inbox shell (Messages · Approval Requests ·
// Daily Summaries). CEO inbox is live; director inboxes route up to the CEO (M1).

interface WorkerLane {
  kind: string;
  label: string;
  description: string;
}
interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}
interface DirectorNode {
  slug: string;
  title: string;
  summary: string;
  mandates: DirectorMandate[];
  goalSlugs: string[];
  workers: WorkerLane[];
  status: "offline" | "live" | "autonomous";
  live: boolean;
  autonomous: boolean;
}
interface OrgChart {
  ceo: { goals: { slug: string; title: string; pct: number }[] };
  directors: DirectorNode[];
}

function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Left nav ──────────────────────────────────────────────────────────────────

function RoleNav({
  org,
  selected,
  onSelect,
}: {
  org: OrgChart;
  selected: string;
  onSelect: (role: string) => void;
}) {
  const ceo = getPersona("ceo");
  return (
    <nav className="space-y-1">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">CEO</p>
      <button
        onClick={() => onSelect("ceo")}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
          selected === "ceo"
            ? "bg-indigo-50 dark:bg-indigo-950"
            : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
        }`}
      >
        <PersonaAvatar persona={ceo} size={30} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{ceo.name}</span>
            <span className="text-[11px] text-zinc-400">{ceo.role}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {org.ceo.goals.length} active goal{org.ceo.goals.length === 1 ? "" : "s"}
          </span>
        </span>
      </button>

      <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Directors</p>
      <div className="space-y-1">
        {org.directors.map((d) => {
          const persona = getPersona(d.slug, d.title);
          const isSel = selected === d.slug;
          return (
            <div key={d.slug}>
              <button
                onClick={() => onSelect(d.slug)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
                  isSel ? "bg-indigo-50 dark:bg-indigo-950" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                <PersonaAvatar persona={persona} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{persona.name}</span>
                    <span className="text-[11px] text-zinc-400">{persona.role}</span>
                  </span>
                  <span className="mt-0.5 block">
                    <StatusBadge status={d.status} />
                  </span>
                </span>
              </button>
              {/* Workers — the box agent_jobs lanes this director owns. */}
              {d.workers.length > 0 && (
                <ul className="ml-9 mt-0.5 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
                  {d.workers.map((w) => (
                    <li
                      key={w.kind}
                      title={w.description}
                      className="truncate py-0.5 text-[11px] text-zinc-500 dark:text-zinc-400"
                    >
                      <span className="font-mono text-[10px] text-zinc-400">{w.kind}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

// ── Decision history (Phase 3 — the supervisable-autonomy ledger) ────────────

interface DecisionRow {
  id: string;
  agent_job_id: string | null;
  pending_action_id: string | null;
  raised_by_function: string;
  routed_to_function: string;
  decided_by: "ceo" | "director" | "human";
  decision: "approved" | "declined" | "escalated";
  reasoning: string | null;
  autonomous: boolean;
  created_at: string;
}

const DECISION_STYLE: Record<DecisionRow["decision"], string> = {
  approved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  declined: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  escalated: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

// The Decision-history view (approval-routing-engine Phase 3): a read-only ledger of every routed
// decision, so the CEO can always audit what a proxy decided + why — in history, never the queue.
// The CEO sees all; a director sees the decisions routed to it. Filterable by decision + autonomy
// (and, for the CEO, by function).
function DecisionHistory({ role, functionSlugs }: { role: string; functionSlugs: string[] }) {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [decision, setDecision] = useState("");
  const [autonomy, setAutonomy] = useState("");
  const [fn, setFn] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    const p = new URLSearchParams({ role });
    if (decision) p.set("decision", decision);
    if (autonomy) p.set("autonomy", autonomy);
    if (fn) p.set("function", fn);
    return fetch(`/api/developer/agents/decisions?${p.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { items: DecisionRow[] }) => {
        setRows(d.items);
        setErr(false);
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, [role, decision, autonomy, fn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectCls =
    "rounded-md border border-zinc-300 bg-white px-2 py-1 text-[12px] text-zinc-700 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={decision} onChange={(e) => setDecision(e.target.value)} className={selectCls}>
          <option value="">All decisions</option>
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
          <option value="escalated">Escalated</option>
        </select>
        <select value={autonomy} onChange={(e) => setAutonomy(e.target.value)} className={selectCls}>
          <option value="">Autonomous + human</option>
          <option value="autonomous">Autonomous only</option>
          <option value="human">Human only</option>
        </select>
        {role === "ceo" && functionSlugs.length > 0 && (
          <select value={fn} onChange={(e) => setFn(e.target.value)} className={selectCls}>
            <option value="">All functions</option>
            <option value="ceo">ceo</option>
            {functionSlugs.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={refresh}
          className="ml-auto rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      <div className="mt-3">
        {loading && !rows ? (
          <div className="py-12 text-center text-sm text-zinc-400">Loading decision history…</div>
        ) : err ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load decision history.
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No decisions recorded yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
              Every routed approve/decline lands here — and once a director is autonomous, its auto-approvals
              are logged here (never the queue), with the reasoning.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map((d) => (
              <li key={d.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${DECISION_STYLE[d.decision]}`}>
                    {d.decision}
                  </span>
                  <span className="text-[12px] text-zinc-600 dark:text-zinc-300">
                    <span className="font-mono text-zinc-400">{d.raised_by_function}</span> → routed to{" "}
                    <span className="font-medium">{d.routed_to_function}</span>
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      d.autonomous
                        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300"
                        : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                    title={`decided by ${d.decided_by}`}
                  >
                    {d.autonomous ? "autonomous" : d.decided_by}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{elapsed(d.created_at)}</span>
                </div>
                {d.reasoning && <p className="mt-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">{d.reasoning}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Inbox shell ─────────────────────────────────────────────────────────────

function InboxShell({ role, title, functionSlugs }: { role: string; title: string; functionSlugs: string[] }) {
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [tab, setTab] = useState<InboxTab | "history">("messages");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState("");

  const refresh = useCallback(
    () =>
      fetch(`/api/developer/agents/inbox?role=${encodeURIComponent(role)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: InboxPayload) => {
          setPayload(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [role],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const items = useMemo(() => payload?.items ?? [], [payload]);
  const countByTab = useMemo(() => {
    const c: Record<InboxTab, number> = { messages: 0, approvals: 0, summaries: 0 };
    for (const it of items) c[it.tab]++;
    return c;
  }, [items]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(
      (it) =>
        it.tab === tab &&
        (!unreadOnly || !it.read) &&
        (!needle || it.title.toLowerCase().includes(needle) || (it.body ?? "").toLowerCase().includes(needle)),
    );
  }, [items, tab, unreadOnly, q]);

  const activeTabDef = INBOX_TABS.find((t) => t.id === tab);

  return (
    <div>
      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {INBOX_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            {t.label}
            {countByTab[t.id] > 0 && (
              <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-300">
                {countByTab[t.id]}
              </span>
            )}
          </button>
        ))}
        {/* Decision history (Phase 3) — the supervisable-autonomy ledger, not a notification type. */}
        <button
          onClick={() => setTab("history")}
          className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            tab === "history"
              ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
              : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          }`}
        >
          Decision history
        </button>
      </div>

      {tab === "history" ? (
        <div className="mt-3">
          <DecisionHistory role={role} functionSlugs={functionSlugs} />
        </div>
      ) : (
      <>
      {/* Filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          className="w-44 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-sm text-zinc-700 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} className="rounded border-zinc-300 dark:border-zinc-600" />
          Unread only
        </label>
        <button
          onClick={refresh}
          className="ml-auto rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {/* Body */}
      <div className="mt-3">
        {tab === "messages" ? (
          // The Messages tab is the Slack-style #directors board (directors-board-gamified, M3) —
          // ONE workspace-wide team channel rendered in every role's inbox, not a per-role log.
          <BoardChannel filter={q} />
        ) : loading && !payload ? (
          <div className="py-12 text-center text-sm text-zinc-400">Loading inbox…</div>
        ) : err ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
            Couldn&apos;t load the inbox.
          </div>
        ) : payload?.routesToCeo ? (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{title} isn&apos;t live yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
              No director is automated, so everything this director would own routes up to the{" "}
              <span className="font-medium">CEO inbox</span>. The approval-routing engine (M2) flips this on.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No {activeTabDef?.label.toLowerCase() ?? "items"} yet.</p>
            <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">{activeTabDef?.emptyHint}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.map((it) => (
              <InboxRow key={it.id} item={it} onActed={refresh} />
            ))}
          </ul>
        )}
      </div>
      </>
      )}
    </div>
  );
}

function InboxRow({ item, onActed }: { item: InboxItem; onActed: () => void }) {
  // A routed Approval Request (M2) renders the investigation + proposed fix INLINE so the decision
  // is one read — no click-through to a separate surface. Approve/Decline drives the unchanged
  // execution path (POST /api/roadmap/approve → worker flips queued_resume).
  if (item.type === APPROVAL_REQUEST_TYPE) {
    return <ApprovalRow item={item} onActed={onActed} />;
  }

  const inner = (
    <div
      className={`rounded-lg border p-3 ${
        item.read
          ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          : "border-indigo-200 bg-indigo-50/40 dark:border-indigo-900/40 dark:bg-indigo-900/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />}
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
          </span>
          {item.body && <p className="mt-0.5 line-clamp-2 text-[12px] text-zinc-500 dark:text-zinc-400">{item.body}</p>}
        </span>
        <span className="shrink-0 text-[10px] text-zinc-400">{elapsed(item.createdAt)}</span>
      </div>
    </div>
  );
  return <li>{item.link ? <Link href={item.link}>{inner}</Link> : inner}</li>;
}

// ── Rich-approval decision in-context (approval-routing-engine Phase 4) ───────
// CEO ruling (2026-06-23): the inbox is the single QUEUE + ENTRY POINT. A SIMPLE approve/decline is
// decided inline on the row; a RICH approval opens a modal launched FROM the row that REUSES the
// existing action logic in-context (no navigation to a scattered standalone card). The decision still
// posts to the unchanged executors, so the gate is never skipped.
//
// Control-tower kinds carry a bespoke 2–3-way decision against their own endpoint (Build/Dismiss,
// Register/Exempt/Dismiss). Multi-action roadmap kinds (plan branches, build prod-actions, migration-fix)
// decide each pending action via POST /api/roadmap/approve. storefront-optimizer's hero image-preview
// flow can't be modal-ized cheaply, so it stays a DOCUMENTED EXCEPTION: the row deep-links to the
// optimizer surface (logged here, not a silent scatter).
const CONTROL_TOWER_KINDS = new Set(["repair", "db_health", "coverage-register"]);
const ROADMAP_MODAL_KINDS = new Set(["plan", "build", "spec-test", "migration-fix"]);
function isModalKind(kind: string | undefined): boolean {
  return Boolean(kind) && (CONTROL_TOWER_KINDS.has(kind!) || ROADMAP_MODAL_KINDS.has(kind!));
}

interface ApprovalAction {
  id: string;
  type: string;
  status: string;
  summary: string;
  preview: string | null;
  cmd: string | null;
  stage: string | null;
}
interface ApprovalDetail {
  jobId: string;
  kind: string;
  specSlug: string | null;
  status: string;
  actions: ApprovalAction[];
}

function ApprovalModal({ item, onClose, onActed }: { item: InboxItem; onClose: () => void; onActed: () => void }) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  const fetchDetail = useCallback(
    () =>
      fetch(`/api/developer/agents/approval-detail?jobId=${encodeURIComponent(item.jobId ?? "")}`)
        .then((r) => (r.ok ? (r.json() as Promise<ApprovalDetail>) : Promise.reject(r.status))),
    [item.jobId],
  );

  useEffect(() => {
    let alive = true;
    fetchDetail()
      .then((d) => alive && (setDetail(d), setLoadErr(false)))
      .catch(() => alive && setLoadErr(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [fetchDetail]);

  // Run one decision against its executor, then re-read the live job: if no pending action remains (the
  // job left needs_approval), refresh the inbox + close; otherwise keep the modal open on the rest.
  const act = async (key: string, url: string, body: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onActed();
      const fresh = await fetchDetail().catch(() => null);
      const stillPending = fresh && fresh.status === "needs_approval" && fresh.actions.some((a) => a.status === "pending");
      if (stillPending) {
        setDetail(fresh);
        setRejectFor(null);
        setNotes("");
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(null);
    }
  };

  const kind = detail?.kind ?? item.kind ?? "";
  const pending = (detail?.actions ?? []).filter((a) => a.status === "pending");

  // The bespoke control-tower decisions, reusing the existing control-tower endpoints in-context.
  const ctEndpoint =
    kind === "repair"
      ? "/api/developer/control-tower/repair"
      : kind === "db_health"
        ? "/api/developer/control-tower/db-health"
        : kind === "coverage-register"
          ? "/api/developer/control-tower/coverage-register"
          : null;

  const btn = "rounded-md px-3 py-1 text-[12px] font-medium disabled:opacity-50";
  const approveBtn = `${btn} bg-emerald-600 text-white hover:bg-emerald-700`;
  const neutralBtn = `${btn} border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`;
  const amberBtn = `${btn} border border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/30`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{item.title}</h3>
            <p className="mt-0.5 text-[11px] text-zinc-400">
              <span className="font-mono">{kind || "approval"}</span> · routed to {item.routedTo ?? "ceo"}
            </p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-[12px] text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            Close
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          {item.body && (
            <pre className="mb-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2 font-sans text-[12px] leading-relaxed text-zinc-600 dark:bg-zinc-950/40 dark:text-zinc-300">
              {item.body}
            </pre>
          )}

          {loading ? (
            <div className="py-8 text-center text-sm text-zinc-400">Loading the approval…</div>
          ) : loadErr ? (
            <div className="py-8 text-center text-sm text-zinc-400">Couldn&apos;t load this approval.</div>
          ) : ctEndpoint ? (
            // ── Control-tower proposal: a single bespoke decision against its own endpoint ──
            <div className="flex flex-wrap items-center gap-2">
              {kind === "coverage-register" ? (
                <>
                  <button disabled={busy !== null} onClick={() => act("register", ctEndpoint, { jobId: item.jobId, action: "register" })} className={approveBtn}>
                    {busy === "register" ? "Queuing…" : "Register"}
                  </button>
                  <button disabled={busy !== null} onClick={() => act("exempt", ctEndpoint, { jobId: item.jobId, action: "exempt" })} className={amberBtn}>
                    {busy === "exempt" ? "…" : "Intentionally-unmonitored"}
                  </button>
                  <button disabled={busy !== null} onClick={() => act("dismiss", ctEndpoint, { jobId: item.jobId, action: "dismiss" })} className={neutralBtn}>
                    {busy === "dismiss" ? "…" : "Dismiss"}
                  </button>
                </>
              ) : (
                <>
                  <button disabled={busy !== null} onClick={() => act("build", ctEndpoint, { jobId: item.jobId, action: "build" })} className={approveBtn}>
                    {busy === "build" ? "Queuing…" : "Build the fix"}
                  </button>
                  <button disabled={busy !== null} onClick={() => act("dismiss", ctEndpoint, { jobId: item.jobId, action: "dismiss" })} className={neutralBtn}>
                    {busy === "dismiss" ? "…" : "Dismiss"}
                  </button>
                </>
              )}
            </div>
          ) : pending.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-zinc-400">No actions still awaiting a decision.</div>
          ) : (
            // ── Roadmap kinds: decide each pending action via the unchanged approve endpoint ──
            <ul className="space-y-2">
              {pending.map((a) => {
                const canReject = a.type === "storefront_campaign" && a.stage === "preview";
                return (
                  <li key={a.id} className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-950/30">
                    {a.summary && <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200">{a.summary}</div>}
                    {(a.preview || a.cmd) && (
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                        {a.preview || (a.cmd ? `$ ${a.cmd}` : "")}
                      </pre>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <button
                        disabled={busy !== null}
                        onClick={() => act(`approve:${a.id}`, "/api/roadmap/approve", { jobId: item.jobId, actionId: a.id, decision: "approve" })}
                        className={approveBtn}
                      >
                        {busy === `approve:${a.id}` ? "Approving…" : "Approve & apply"}
                      </button>
                      <button
                        disabled={busy !== null}
                        onClick={() => act(`decline:${a.id}`, "/api/roadmap/approve", { jobId: item.jobId, actionId: a.id, decision: "decline" })}
                        className={neutralBtn}
                      >
                        {busy === `decline:${a.id}` ? "Declining…" : "Decline"}
                      </button>
                      {canReject && (
                        <button disabled={busy !== null} onClick={() => setRejectFor(rejectFor === a.id ? null : a.id)} className={amberBtn}>
                          Reject with notes
                        </button>
                      )}
                    </div>
                    {canReject && rejectFor === a.id && (
                      <div className="mt-2 space-y-1.5">
                        <textarea
                          rows={2}
                          value={notes}
                          onChange={(e) => setNotes(e.target.value)}
                          placeholder="What to change before the next candidate…"
                          className="w-full rounded border border-zinc-200 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                        />
                        <button
                          disabled={busy !== null || !notes.trim()}
                          onClick={() => act(`reject:${a.id}`, "/api/roadmap/approve", { jobId: item.jobId, actionId: a.id, decision: "reject", notes })}
                          className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}
                        >
                          {busy === `reject:${a.id}` ? "Sending…" : "Send notes → regenerate"}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {error && <p className="mt-2 text-[11px] text-rose-500">{error}</p>}
          {item.deepLink && (
            <Link href={item.deepLink} className="mt-3 inline-block text-[12px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400">
              Open the full surface →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalRow({ item, onActed }: { item: InboxItem; onActed: () => void }) {
  const [busy, setBusy] = useState<null | "approve" | "decline">(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Decision routing (Phase 4): a control-tower kind always opens the modal (its decision is bespoke,
  // 2–3-way, against its own endpoint — never a plain inline approve). Otherwise a single plain action
  // is decided inline; a multi-action roadmap kind opens the modal; anything else (storefront hero
  // preview, unknown kinds) falls back to the documented-exception deep-link.
  const isControlTower = CONTROL_TOWER_KINDS.has(item.kind ?? "");
  const canDecideInline = Boolean(item.jobId && item.approveActionId) && !isControlTower;
  const canUseModal = Boolean(item.jobId) && !canDecideInline && isModalKind(item.kind);

  const decide = async (decision: "approve" | "decline") => {
    if (!item.jobId || !item.approveActionId) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: item.jobId, actionId: item.approveActionId, decision }),
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

  return (
    <li
      className={`rounded-lg border p-3 ${
        item.read
          ? "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
          : "border-indigo-200 bg-indigo-50/40 dark:border-indigo-900/40 dark:bg-indigo-900/10"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />}
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>
        </span>
        <span className="shrink-0 text-[10px] text-zinc-400">{elapsed(item.createdAt)}</span>
      </div>
      {item.body && (
        <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2 font-sans text-[12px] leading-relaxed text-zinc-600 dark:bg-zinc-950/40 dark:text-zinc-300">
          {item.body}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canDecideInline ? (
          <>
            <button
              onClick={() => decide("approve")}
              disabled={busy !== null}
              className="rounded-md bg-emerald-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              onClick={() => decide("decline")}
              disabled={busy !== null}
              className="rounded-md border border-zinc-300 px-3 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {busy === "decline" ? "Declining…" : "Decline"}
            </button>
          </>
        ) : canUseModal ? (
          <button
            onClick={() => setModalOpen(true)}
            className="rounded-md bg-indigo-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-indigo-700"
          >
            Review &amp; decide
          </button>
        ) : null}
        {item.deepLink && !canUseModal && (
          <Link
            href={item.deepLink}
            className="text-[12px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            {canDecideInline ? "Open full surface →" : "Decide on the full surface →"}
          </Link>
        )}
        {error && <span className="text-[11px] text-rose-500">{error}</span>}
      </div>
      {modalOpen && <ApprovalModal item={item} onClose={() => setModalOpen(false)} onActed={onActed} />}
    </li>
  );
}

// ── Right pane header ─────────────────────────────────────────────────────────

// Owner-only toggle behind the approval router — flips a director live / autonomous.
// live && autonomous ⇒ this director auto-approves its tools' requests; else they route to the CEO.
function AutonomyToggle({ director, onChange }: { director: DirectorNode; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  const set = async (patch: { live?: boolean; autonomous?: boolean }) => {
    setBusy(true);
    try {
      await fetch("/api/developer/agents/autonomy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionSlug: director.slug, ...patch }),
      });
      onChange();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
      <span className="text-[12px] font-medium text-zinc-600 dark:text-zinc-300">Autonomy</span>
      <label className="flex items-center gap-1.5 text-[12px] text-zinc-600 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={director.live}
          disabled={busy}
          onChange={(e) => set({ live: e.target.checked })}
          className="rounded border-zinc-300 dark:border-zinc-600"
        />
        Live <span className="text-zinc-400">(agent running)</span>
      </label>
      <label
        className={`flex items-center gap-1.5 text-[12px] ${director.live ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-400"}`}
        title={director.live ? "" : "Enable Live first — an offline director can't auto-approve."}
      >
        <input
          type="checkbox"
          checked={director.autonomous}
          disabled={busy || !director.live}
          onChange={(e) => set({ autonomous: e.target.checked })}
          className="rounded border-zinc-300 dark:border-zinc-600"
        />
        Autonomous <span className="text-zinc-400">(auto-approves)</span>
      </label>
      <span className="ml-auto text-[11px] text-zinc-400">
        {director.autonomous ? "Approvals route here + log to history" : "Approvals route to the CEO"}
      </span>
    </div>
  );
}

function RoleHeader({
  org,
  role,
  onChange,
  xp,
}: {
  org: OrgChart;
  role: string;
  onChange: () => void;
  xp: Record<string, DirectorXp>;
}) {
  if (role === "ceo") {
    const persona = getPersona("ceo");
    return (
      <div className="mb-4">
        <div className="flex items-center gap-3">
          <PersonaAvatar persona={persona} size={42} />
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {persona.name} <span className="text-sm font-normal text-zinc-400">· {persona.role}</span>
            </h2>
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{persona.personality}</p>
          </div>
          <Link
            href="/dashboard/agents/ceo"
            className="ml-auto text-[12px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            View profile →
          </Link>
        </div>
        {org.ceo.goals.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {org.ceo.goals.map((g) => (
              <Link
                key={g.slug}
                href={`/dashboard/roadmap/goals`}
                className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {g.title} · {g.pct}%
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  }

  const d = org.directors.find((x) => x.slug === role);
  if (!d) {
    // A Worker node (a box agent_jobs lane) was selected from the org tree (Phase 4).
    // Phase 5 gives workers their own profile/responsibilities page; until then show a
    // minimal header + its routes-to-CEO inbox so the node click lands somewhere coherent.
    const parent = org.directors.find((x) => x.workers.some((w) => w.kind === role));
    const worker = parent?.workers.find((w) => w.kind === role);
    if (!parent || !worker) return null;
    const wp = getPersona(worker.kind, worker.label);
    const dp = getPersona(parent.slug, parent.title);
    return (
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <PersonaAvatar persona={wp} size={42} />
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              {wp.name} <span className="text-sm font-normal text-zinc-400">· {wp.role}</span>
              <span className="font-mono text-[11px] text-zinc-400">{worker.kind}</span>
            </h2>
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{worker.description}</p>
          </div>
          <span className="ml-auto flex flex-col items-end gap-0.5 text-[12px]">
            <span className="text-zinc-400" title={`Reports to ${dp.name} · ${dp.role}`}>
              reports to {dp.name} · {dp.role}
            </span>
            <Link
              href={`/dashboard/agents/${encodeURIComponent(worker.kind)}`}
              className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
            >
              View profile →
            </Link>
          </span>
        </div>
      </div>
    );
  }
  const persona = getPersona(d.slug, d.title);
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-3">
        <PersonaAvatar persona={persona} size={42} />
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {persona.name} <span className="text-sm font-normal text-zinc-400">· {persona.role}</span>
            <StatusBadge status={d.status} />
          </h2>
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{persona.personality}</p>
        </div>
        <span className="ml-auto flex flex-col items-end gap-0.5 text-[12px]">
          <Link
            href={`/dashboard/agents/${encodeURIComponent(d.slug)}`}
            className="font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            View profile →
          </Link>
          <Link
            href={`/dashboard/roadmap/map`}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            {d.slug} →
          </Link>
        </span>
      </div>
      {d.mandates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.mandates.map((m) => (
            <span
              key={m.name}
              className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
            >
              {m.name}
              {m.specCount > 0 && <span className="ml-1 text-zinc-400">· {m.specCount}</span>}
            </span>
          ))}
        </div>
      )}
      {/* Gamified XP card (directors-board-gamified, M3 Phase 3) — derived, display-only counts. */}
      {xp[d.slug] && <XpCard xp={xp[d.slug]} />}
      <AutonomyToggle director={d} onChange={onChange} />
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function AgentsPage() {
  const workspace = useWorkspace();
  const [org, setOrg] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [role, setRole] = useState("ceo");
  // Derived per-director XP (directors-board-gamified M3 Phase 3) — display-only counts.
  const [xp, setXp] = useState<Record<string, DirectorXp>>({});
  // "inbox" = the role nav + three-tab inbox (Message Board — the default); "org" = the visual org-tree.
  // The org-chart now has its own route (/dashboard/agents/org-chart); this page opens on the inbox.
  const [view, setView] = useState<"org" | "inbox">("inbox");

  // Deep-link support: a profile page (Phase 5) links back here with ?view=inbox&role=…
  // so its "Open inbox →" lands on that role's inbox. Read once on mount (client-only).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get("role");
    const v = p.get("view");
    if (r) setRole(r);
    if (v === "inbox" || v === "org") setView(v);
  }, []);

  const loadOrg = useCallback(
    () =>
      fetch("/api/developer/agents")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: OrgChart) => {
          setOrg(d);
          setErr(false);
        })
        .catch(() => setErr(true))
        .finally(() => setLoading(false)),
    [],
  );

  const loadXp = useCallback(
    () =>
      fetch("/api/developer/agents/xp")
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d: { xp: Record<string, DirectorXp> }) => setXp(d.xp ?? {}))
        .catch(() => setXp({})),
    [],
  );

  useEffect(() => {
    if (workspace.role !== "owner") return;
    loadOrg();
    loadXp();
  }, [workspace.role, loadOrg, loadXp]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const title = role === "ceo" ? "CEO" : getPersona(role, org?.directors.find((d) => d.slug === role)?.title).name;

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Agents</h1>
        <div className="flex items-center gap-3">
          <div className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
            {(["org", "inbox"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  view === v
                    ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                }`}
              >
                {v === "org" ? "Org chart" : "Inbox"}
              </button>
            ))}
          </div>
          <Link
            href="/dashboard/developer/control-tower"
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Control Tower →
          </Link>
        </div>
      </div>
      <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
        The org chart — CEO · Directors · Workers — read live from the brain, each role with the same three-tab
        inbox. No director is automated yet, so every approval routes to one CEO inbox.
      </p>

      {loading && !org ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading the org chart…</div>
      ) : err && !org ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Couldn&apos;t load the Agents hub.
        </div>
      ) : org && view === "org" ? (
        // The visual employee/org chart — CEO → Directors → Workers (Phase 4). Every node
        // links to that role's profile detail page (Phase 5, /dashboard/agents/[role]).
        <OrgTree org={org} />
      ) : org ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
          <aside className="lg:border-r lg:border-zinc-200 lg:pr-4 dark:lg:border-zinc-800">
            <RoleNav org={org} selected={role} onSelect={setRole} />
          </aside>
          <section>
            <RoleHeader org={org} role={role} onChange={loadOrg} xp={xp} />
            <InboxShell key={role} role={role} title={title} functionSlugs={org.directors.map((d) => d.slug)} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
