"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface TodoRow {
  id: string;
  group_id: string;
  source: string;
  source_ticket_id: string | null;
  action_type: string;
  summary: string;
  urgency: string;
  status: string;
  confidence: number | null;
  created_at: string;
  approved_at: string | null;
  approval_role: string | null;
  ticket_subject: string | null;
  customer_name: string;
  can_approve: boolean;
}

const STATUS_OPTIONS = ["pending", "approved", "executed", "rejected", "superseded", "failed", "all"];
const URGENCY_OPTIONS = ["all", "urgent", "normal", "low"];
const SOURCE_OPTIONS = ["all", "ticket", "csat", "cron", "manual"];
const ACTION_TYPE_OPTIONS = [
  "all",
  "customer_reply",
  "customer_action",
  "ticket_close",
  "ticket_analysis_rescore",
];

const ACTION_BADGE: Record<string, string> = {
  customer_reply: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  customer_action: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  ticket_close: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  ticket_analysis_rescore: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
};

const URGENCY_DOT: Record<string, string> = {
  urgent: "bg-rose-500",
  normal: "bg-amber-400",
  low: "bg-zinc-300 dark:bg-zinc-600",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  executed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  superseded: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function shortType(t: string): string {
  return t.replace(/_/g, " ");
}

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

interface Group {
  group_id: string;
  todos: TodoRow[];
  customer_name: string;
  ticket_subject: string | null;
  source_ticket_id: string | null;
  urgency: string;
  created_at: string;
}

export default function TodosPage() {
  const workspace = useWorkspace();
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("pending");
  const [urgency, setUrgency] = useState("all");
  const [actionType, setActionType] = useState("all");
  const [source, setSource] = useState("all");
  const [mine, setMine] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    qs.set("status", status);
    if (urgency !== "all") qs.set("urgency", urgency);
    if (actionType !== "all") qs.set("action_type", actionType);
    if (source !== "all") qs.set("source", source);
    if (mine) qs.set("mine", "true");
    fetch(`/api/todos?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => setTodos(d.todos || []))
      .catch(() => setTodos([]))
      .finally(() => setLoading(false));
  }, [status, urgency, actionType, source, mine]);

  useEffect(() => {
    load();
  }, [load, workspace.id]);

  // Collapse todos sharing a group_id into one row.
  const groupsMap = new Map<string, Group>();
  const urgencyRank: Record<string, number> = { urgent: 0, normal: 1, low: 2 };
  for (const t of todos) {
    let g = groupsMap.get(t.group_id);
    if (!g) {
      g = {
        group_id: t.group_id,
        todos: [],
        customer_name: t.customer_name,
        ticket_subject: t.ticket_subject,
        source_ticket_id: t.source_ticket_id,
        urgency: t.urgency,
        created_at: t.created_at,
      };
      groupsMap.set(t.group_id, g);
    }
    g.todos.push(t);
    if ((urgencyRank[t.urgency] ?? 1) < (urgencyRank[g.urgency] ?? 1)) g.urgency = t.urgency;
  }
  const groups = [...groupsMap.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">To Do</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Proposed actions awaiting your approval. Approving fires execution; rejecting routes the ticket to manual handling.
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        <Select label="Urgency" value={urgency} onChange={setUrgency} options={URGENCY_OPTIONS} />
        <Select label="Action" value={actionType} onChange={setActionType} options={ACTION_TYPE_OPTIONS} />
        <Select label="Source" value={source} onChange={setSource} options={SOURCE_OPTIONS} />
        <label className="ml-2 flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} className="rounded" />
          Items I can approve
        </label>
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No todos match these filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium"></th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Summary</th>
                <th className="px-3 py-2 font-medium">Actions</th>
                <th className="px-3 py-2 font-medium">Proposed</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {groups.map((g) => {
                const lead = g.todos[0];
                const isOpen = expanded.has(g.group_id);
                const multi = g.todos.length > 1;
                return (
                  <FragmentRows
                    key={g.group_id}
                    group={g}
                    lead={lead}
                    isOpen={isOpen}
                    multi={multi}
                    onToggle={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.group_id)) next.delete(g.group_id);
                        else next.add(g.group_id);
                        return next;
                      })
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRows({
  group,
  lead,
  isOpen,
  multi,
  onToggle,
}: {
  group: Group;
  lead: TodoRow;
  isOpen: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
        <td className="px-3 py-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${URGENCY_DOT[group.urgency] || URGENCY_DOT.normal}`} />
        </td>
        <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{group.customer_name}</td>
        <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
          <Link href={`/dashboard/tickets/todos/${lead.id}`} className="hover:underline">
            {lead.summary}
          </Link>
          {group.ticket_subject && (
            <span className="ml-2 text-xs text-zinc-400">· {group.ticket_subject}</span>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {group.todos.map((t) => (
              <span
                key={t.id}
                className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${ACTION_BADGE[t.action_type] || ACTION_BADGE.ticket_close}`}
              >
                {shortType(t.action_type)}
              </span>
            ))}
          </div>
        </td>
        <td className="px-3 py-2 text-xs text-zinc-500">{formatDate(group.created_at)}</td>
        <td className="px-3 py-2">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_BADGE[lead.status] || STATUS_BADGE.pending}`}>
            {lead.status}
          </span>
          {multi && (
            <button onClick={onToggle} className="ml-2 text-xs text-zinc-400 hover:text-zinc-600">
              {isOpen ? "▾" : "▸"} {group.todos.length}
            </button>
          )}
        </td>
      </tr>
      {isOpen &&
        multi &&
        group.todos.map((t) => (
          <tr key={t.id} className="bg-zinc-50/60 text-xs dark:bg-zinc-900/30">
            <td></td>
            <td></td>
            <td className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400">
              <Link href={`/dashboard/tickets/todos/${t.id}`} className="hover:underline">
                {t.summary}
              </Link>
            </td>
            <td className="px-3 py-1.5">
              <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-medium ${ACTION_BADGE[t.action_type] || ACTION_BADGE.ticket_close}`}>
                {shortType(t.action_type)}
              </span>
            </td>
            <td></td>
            <td className="px-3 py-1.5">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium capitalize ${STATUS_BADGE[t.status] || STATUS_BADGE.pending}`}>
                {t.status}
              </span>
            </td>
          </tr>
        ))}
    </>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    </label>
  );
}
