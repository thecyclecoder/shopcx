"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { INBOX_TABS, APPROVAL_REQUEST_TYPE, type InboxTab, type InboxItem, type InboxPayload, type InboxApprovalAction } from "@/lib/agents/inbox";

// Per-role inbox — moved off the Agents hub onto the role profile page
// (agents-hub-role-inboxes IA refactor). Renders the role's inbox tabs:
// Approval Requests · Daily Summaries · Decision history · Director grades
// (+ the autonomy toggle for a director). The shared #directors board now
// lives on the hub, so the Messages tab is intentionally dropped here.

interface DirectorMandate {
  name: string;
  metric?: string;
  specCount: number;
}
interface WorkerLane {
  kind: string;
  label: string;
  description: string;
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

function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
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

// ── Director grades (Phase 4 — feed grades back to tighten/loosen the leash) ──

interface GradeReportRow {
  id: string;
  dimension: "auto-approval" | "goal-escort";
  grade: number | null;
  reasoning: string | null;
  graded_by: "agent" | "human";
  overridden_by: string | null;
  target_label: string;
  leash_category: string | null;
  created_at: string;
}
interface DimensionStatUi {
  dimension: "auto-approval" | "goal-escort";
  graded: number;
  avgGrade: number | null;
  trend: "up" | "down" | "flat" | null;
}
interface CategoryStatUi {
  category: string;
  graded: number;
  avgGrade: number | null;
}
interface LeashRecUi {
  id: string;
  scope: "dimension" | "category";
  dimension: string;
  category: string | null;
  action: "loosen" | "tighten";
  sampleSize: number;
  avgGrade: number;
  rationale: string;
}
interface GradeReport {
  dimensions: DimensionStatUi[];
  categories: CategoryStatUi[];
  recommendations: LeashRecUi[];
  rows: GradeReportRow[];
  proposedRules: Array<{ id: string; title: string; content: string; created_at: string }>;
  autonomy: { function: string; live: boolean; autonomous: boolean };
}

function gradeColor(g: number | null): string {
  if (g == null) return "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400";
  if (g >= 8) return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  if (g >= 6) return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300";
}
const TREND_ARROW: Record<string, string> = { up: "↑", down: "↓", flat: "→" };

// The Director grading report (director-loop-grading Phase 4 — the CEO's report contract for the
// director). Per-dimension + per-category grades with a trend, the actionable leash-adjustment
// recommendations (loosen/tighten — the CEO disposes via the Autonomy toggle; the loop never widens
// its own leash), the proposed calibration rules, and the recent grades with a one-click override.
function DirectorGrades() {
  const [report, setReport] = useState<GradeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [ovGrade, setOvGrade] = useState("");
  const [ovReason, setOvReason] = useState("");
  const [ovProposeRule, setOvProposeRule] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetch("/api/developer/agents/grades")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: GradeReport) => {
        setReport(d);
        setErr(false);
      })
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const submitOverride = async (gradeId: string) => {
    const g = Number(ovGrade);
    if (!Number.isInteger(g) || g < 1 || g > 10 || !ovReason.trim()) return;
    setBusy(true);
    try {
      await fetch(`/api/developer/agents/grades/${gradeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grade: g, reason: ovReason.trim(), propose_rule: ovProposeRule }),
      });
      setOverrideId(null);
      setOvGrade("");
      setOvReason("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const reviewRule = async (ruleId: string, status: "approved" | "rejected") => {
    setBusy(true);
    try {
      await fetch(`/api/developer/agents/grader-prompts/${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (loading && !report) return <div className="py-12 text-center text-sm text-zinc-400">Loading director grades…</div>;
  if (err)
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
        Couldn&apos;t load director grades.
      </div>
    );
  if (!report || (report.rows.length === 0 && report.recommendations.length === 0))
    return (
      <div className="rounded-lg border border-dashed border-zinc-200 px-4 py-10 text-center dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">No director calls graded yet.</p>
        <p className="mx-auto mt-1 max-w-sm text-[12px] text-zinc-400">
          Once the Platform/DevOps Director auto-approves calls or escorts goals, each concluded call is graded
          1–10 here — and sustained grades surface as leash-adjustment recommendations you confirm.
        </p>
      </div>
    );

  const env = report.autonomy;
  return (
    <div className="space-y-5">
      {/* Recommendations — the CEO disposes (no self-promotion). */}
      <section>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Leash-adjustment recommendations
        </h3>
        <p className="mt-0.5 text-[11px] text-zinc-400">
          Current Platform envelope:{" "}
          <span className="font-medium text-zinc-600 dark:text-zinc-300">
            {env.autonomous ? "autonomous" : env.live ? "live (not autonomous)" : "offline"}
          </span>
          . Recommendations only — the envelope changes when you toggle Autonomy above, never on its own.
        </p>
        {report.recommendations.length === 0 ? (
          <p className="mt-2 text-[12px] text-zinc-400">No leash adjustment recommended — grades are mid-range or the sample is thin.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {report.recommendations.map((r) => (
              <li
                key={r.id}
                className={`rounded-lg border p-3 ${
                  r.action === "loosen"
                    ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/10"
                    : "border-rose-200 bg-rose-50/50 dark:border-rose-900/40 dark:bg-rose-950/10"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      r.action === "loosen"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                    }`}
                  >
                    {r.action === "loosen" ? "Widen leash" : "Narrow leash"}
                  </span>
                  <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                    {r.category ? `${r.category} · ${r.dimension}` : r.dimension}
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-400">
                    avg {r.avgGrade}/10 · {r.sampleSize} call{r.sampleSize === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-zinc-600 dark:text-zinc-300">{r.rationale}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Per-dimension + per-category stats */}
      <section>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Grades by dimension</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {report.dimensions.map((d) => (
            <div key={d.dimension} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">{d.dimension}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-zinc-500">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${gradeColor(d.avgGrade)}`}>
                  avg {d.avgGrade ?? "—"}/10
                </span>
                <span>· {d.graded} graded</span>
                {d.trend && <span title="recent vs prior trend">{TREND_ARROW[d.trend]}</span>}
              </div>
            </div>
          ))}
        </div>
        {report.categories.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {report.categories.map((c) => (
              <span
                key={c.category}
                className="rounded-full border border-zinc-200 px-2 py-0.5 text-[11px] text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                title={`${c.graded} graded auto-approvals`}
              >
                {c.category}: avg {c.avgGrade ?? "—"}/10 · {c.graded}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Proposed calibration rules — only an APPROVED rule reaches the grader. */}
      {report.proposedRules.length > 0 && (
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Proposed calibration rules
          </h3>
          <ul className="mt-2 space-y-2">
            {report.proposedRules.map((rule) => (
              <li key={rule.id} className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 dark:border-indigo-900/40 dark:bg-indigo-900/10">
                <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-100">{rule.title}</div>
                <p className="mt-0.5 text-[12px] text-zinc-600 dark:text-zinc-300">{rule.content}</p>
                <div className="mt-2 flex gap-2">
                  <button
                    disabled={busy}
                    onClick={() => reviewRule(rule.id, "approved")}
                    className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Approve rule
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => reviewRule(rule.id, "rejected")}
                    className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent grades — each with a one-click override (records graded_by='human'). */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Recent grades</h3>
          <button
            onClick={refresh}
            className="rounded-md border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
        <ul className="mt-2 space-y-2">
          {report.rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${gradeColor(row.grade)}`}>{row.grade ?? "—"}/10</span>
                <span className="text-[11px] font-medium uppercase text-zinc-400">{row.dimension}</span>
                <span className="text-[12px] text-zinc-600 dark:text-zinc-300">{row.target_label}</span>
                {row.graded_by === "human" && (
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                    overridden
                  </span>
                )}
                <button
                  onClick={() => {
                    setOverrideId(overrideId === row.id ? null : row.id);
                    setOvGrade(String(row.grade ?? ""));
                    setOvReason("");
                  }}
                  className="ml-auto text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
                >
                  {overrideId === row.id ? "Cancel" : "Override"}
                </button>
              </div>
              {row.reasoning && <p className="mt-1 text-[12px] text-zinc-500 dark:text-zinc-400">{row.reasoning}</p>}
              {overrideId === row.id && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={ovGrade}
                    onChange={(e) => setOvGrade(e.target.value)}
                    placeholder="1-10"
                    className="w-16 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[12px] dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <input
                    value={ovReason}
                    onChange={(e) => setOvReason(e.target.value)}
                    placeholder="Why you're overriding…"
                    className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[12px] dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <input type="checkbox" checked={ovProposeRule} onChange={(e) => setOvProposeRule(e.target.checked)} className="rounded border-zinc-300 dark:border-zinc-600" />
                    Propose calibration rule
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => submitOverride(row.id)}
                    className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Save override
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ── Inbox shell ─────────────────────────────────────────────────────────────

// The Messages tab (the shared #directors board) is intentionally dropped here —
// the board now lives on the Agents hub. So the role inbox surfaces only the
// non-board tabs: Approval Requests · Daily Summaries · Decision history ·
// Director grades. The default tab is therefore "approvals".
const ROLE_INBOX_TABS = INBOX_TABS.filter((t) => t.id !== "messages");

export function RoleInbox({ role, title, functionSlugs, hideGrades }: { role: string; title: string; functionSlugs: string[]; hideGrades?: boolean }) {
  const [payload, setPayload] = useState<InboxPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [tab, setTab] = useState<InboxTab | "history" | "grades">("approvals");
  // The director-grading report (Phase 4) is the CEO's report contract for the Platform director —
  // show it on the CEO (who grades). The Platform director profile has a dedicated Grades section now,
  // so it passes hideGrades to drop the redundant inbox copy (CEO has no standalone section → keeps it).
  const showGrades = !hideGrades && (role === "ceo" || role === "platform");
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

  const activeTabDef = ROLE_INBOX_TABS.find((t) => t.id === tab);

  return (
    <div>
      {/* Tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {ROLE_INBOX_TABS.map((t) => (
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
        {/* Director grades (Phase 4) — per-period grades + trend + leash-adjustment recommendations. */}
        {showGrades && (
          <button
            onClick={() => setTab("grades")}
            className={`relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === "grades"
                ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            }`}
          >
            Director grades
          </button>
        )}
      </div>

      {tab === "history" ? (
        <div className="mt-3">
          <DecisionHistory role={role} functionSlugs={functionSlugs} />
        </div>
      ) : tab === "grades" ? (
        <div className="mt-3">
          <DirectorGrades />
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
        {loading && !payload ? (
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

function ApprovalRow({ item, onActed }: { item: InboxItem; onActed: () => void }) {
  // approval-routing-engine Phase 4: decide EVERY pending action inline — a multi-action build or a
  // multi-branch plan is resolved entirely here (the spec-card / Control-Tower standalone cards are
  // retired). `item.actions` is the live still-pending list; an empty list ⇒ a multi-CHOICE job
  // (coverage register/exempt, hero reject-with-notes) the inbox can't binary-decide → deep-link out.
  const actions: InboxApprovalAction[] =
    item.actions && item.actions.length
      ? item.actions
      : item.approveActionId
        ? [{ id: item.approveActionId, summary: item.title }]
        : [];
  const [busy, setBusy] = useState<string | null>(null); // `${actionId}:${decision}`
  const [error, setError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  // bounce-escalation-back-to-director — Send back to {Director} composer state.
  const [bouncing, setBouncing] = useState(false);
  const [bounceOpen, setBounceOpen] = useState(false);
  const [bounceNote, setBounceNote] = useState("");
  // Show "Send back to {Director}" when (a) a director escalated this card, (b) we know the lane to
  // re-invoke, and (c) the bounce-back depth cap (one round-trip) hasn't been hit. Genuine CEO-only
  // escalations (no escalated_by_director) get Dismiss only.
  const canBounce = Boolean(item.escalatedBy && item.bounceLane && (item.bouncedBackDepth ?? 0) < 1);
  const directorName = item.escalatedBy ? item.escalatedBy.charAt(0).toUpperCase() + item.escalatedBy.slice(1) : "Director";

  // Clear the item without deciding here — for a standalone escalation (no job to auto-reap) or one the
  // CEO already decided on the full surface. Hides it from the inbox; the underlying job is untouched.
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

  const confirmBounce = async () => {
    setBouncing(true);
    setError(null);
    try {
      const res = await fetch("/api/developer/agents/inbox/bounce-back", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationId: item.id, note: bounceNote.trim() || undefined }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      onActed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setBouncing(false);
    }
  };

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

  const canDecideInline = Boolean(item.jobId && actions.length);

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
      {/* Multi-CHOICE job (no inline actions): show the investigation + deep-link to the canonical surface. */}
      {!canDecideInline && item.body && (
        <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2 font-sans text-[12px] leading-relaxed text-zinc-600 dark:bg-zinc-950/40 dark:text-zinc-300">
          {item.body}
        </pre>
      )}
      {/* One sub-card per pending action — each decided with its own Approve/Decline. */}
      {canDecideInline &&
        actions.map((a) => (
          <div
            key={a.id}
            className="mt-2 rounded-md border border-zinc-200 bg-white p-2 dark:border-zinc-800 dark:bg-zinc-900"
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
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 font-sans text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-950/40 dark:text-zinc-300">
                {(() => {
                  // out-of-leash-approval-show-exact-cmd — for a `ceo-authorized-out-of-leash` action, always
                  // render the literal command (`$ ${a.cmd}`) IN ADDITION TO preview, so the CEO sees the byte-
                  // identical cmd runCeoAuthorizedOutOfLeashJob will execute, not just Ada's narrative. The
                  // preview builder already includes the cmd inline, but a defensive re-render here guarantees
                  // the command surfaces even if the preview shape ever drifts.
                  const parts: string[] = [];
                  if (a.preview) parts.push(a.preview);
                  const cmdLine = a.cmd ? `$ ${a.cmd}` : "";
                  if (cmdLine && (a.outOfLeash || !a.preview) && !parts.some((p) => p.includes(cmdLine))) {
                    parts.push(cmdLine);
                  }
                  return parts.join("\n\n");
                })()}
              </pre>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => decide(a.id, "approve")}
                disabled={busy !== null}
                className="rounded-md bg-emerald-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === `${a.id}:approve` ? "Approving…" : "Approve"}
              </button>
              <button
                onClick={() => decide(a.id, "decline")}
                disabled={busy !== null}
                className="rounded-md border border-zinc-300 px-3 py-1 text-[12px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {busy === `${a.id}:decline` ? "Declining…" : "Decline"}
              </button>
            </div>
          </div>
        ))}
      {/* bounce-escalation-back-to-director — inline composer for the Send-back note (CEO's one-liner). */}
      {bounceOpen && canBounce && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/60 p-2 dark:border-amber-900/40 dark:bg-amber-950/20">
          <p className="text-[11px] text-amber-800 dark:text-amber-200">
            Sending this back to <span className="font-medium">{directorName}</span> with the richer judgment-lanes verdict
            surface (fold_now / author_followup_spec / dismiss_candidate, plus the lane&apos;s native ones). One round-trip
            only — if it still can&apos;t land, it comes back with both diagnoses.
          </p>
          <textarea
            value={bounceNote}
            onChange={(e) => setBounceNote(e.target.value.slice(0, 500))}
            placeholder="Optional one-line note for the director (e.g. &quot;your fold_now read looks right — go ahead&quot;)"
            rows={2}
            className="mt-1.5 w-full resize-none rounded-md border border-amber-300 bg-white px-2 py-1 text-[12px] text-zinc-700 placeholder:text-zinc-400 focus:border-amber-500 focus:outline-none dark:border-amber-800 dark:bg-zinc-900 dark:text-zinc-200"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={confirmBounce}
              disabled={bouncing}
              className="rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {bouncing ? "Sending…" : "Confirm send-back"}
            </button>
            <button
              onClick={() => {
                setBounceOpen(false);
                setBounceNote("");
              }}
              disabled={bouncing}
              className="text-[11px] text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* Footer: deep-link to the full surface (multi-choice / standalone) on the left; Send back +
          Dismiss on the right. Send-back is only shown for a director-escalation card under the depth cap. */}
      <div className="mt-2 flex items-center justify-between gap-2">
        {item.deepLink && !canDecideInline ? (
          <Link
            href={item.deepLink}
            className="text-[12px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            Decide on the full surface →
          </Link>
        ) : (
          <span />
        )}
        <span className="flex shrink-0 items-center gap-3">
          {canBounce && !bounceOpen && (
            <button
              onClick={() => setBounceOpen(true)}
              disabled={dismissing || bouncing || busy !== null}
              className="text-[11px] font-medium text-amber-600 hover:text-amber-700 disabled:opacity-50 dark:text-amber-400"
              title={`Send back to ${directorName} to re-investigate with the richer verdict surface`}
            >
              Send back to {directorName}
            </button>
          )}
          <button
            onClick={dismiss}
            disabled={dismissing || bouncing || busy !== null}
            className="text-[11px] text-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-200"
            title="Clear this from your inbox (the underlying job is untouched)"
          >
            {dismissing ? "Dismissing…" : "Dismiss"}
          </button>
        </span>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-500">{error}</p>}
    </li>
  );
}

// ── Autonomy toggle ───────────────────────────────────────────────────────────

// Owner-only toggle behind the approval router — flips a director live / autonomous.
// live && autonomous ⇒ this director auto-approves its tools' requests; else they route to the CEO.
export function AutonomyToggle({ director, onChange }: { director: DirectorNode; onChange: () => void }) {
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
