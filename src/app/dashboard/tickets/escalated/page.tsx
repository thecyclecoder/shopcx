"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { AiInvestigationBadge } from "@/components/ai-investigation-badge";
import { useTriageInProgress } from "@/lib/use-triage-in-progress";
import { resolveEscalationPersona } from "@/lib/ticket-escalation-persona";

interface Row {
  id: string;
  subject: string | null;
  status: string;
  channel: string;
  escalation_reason: string | null;
  escalated_at: string;
  customer_name: string;
  routed_to: string;
  routed_name: string;
  escalated_to: string | null;
}

interface Chips {
  all: number;
  routine_pending: number;
  awaiting_approval: number;
  approved_pending_execute: number;
  rejected_me: number;
  assigned_human_legacy: number;
}

const CHIP_DEFS: Array<{ key: keyof Chips; label: string; match: (r: Row, uid: string) => boolean }> = [
  { key: "all", label: "All", match: () => true },
  { key: "routine_pending", label: "Routine pending", match: (r) => r.routed_to === "routine" },
  { key: "awaiting_approval", label: "Awaiting approval", match: (r) => r.routed_to === "todo_pending" },
  { key: "approved_pending_execute", label: "Approved, pending execute", match: (r) => r.routed_to === "todo_approved" },
  { key: "rejected_me", label: "Rejected → me", match: (r, uid) => r.routed_to === "rejected" && r.escalated_to === uid },
  { key: "assigned_human_legacy", label: "Assigned to human (legacy)", match: (r) => r.routed_to === "assigned" },
];

// A routine escalation is hard-called by June (CS Director) — the fallback label
// resolves to her identity, not a generic robot label. See resolveEscalationPersona.
const ROUTINE_ESCALATION_PERSONA = resolveEscalationPersona(new Date().toISOString(), null);
const ROUTINE_LABEL = ROUTINE_ESCALATION_PERSONA
  ? `${ROUTINE_ESCALATION_PERSONA.emoji} ${ROUTINE_ESCALATION_PERSONA.name}`
  : "🤖 AI Routine";

const ROUTED_BADGE: Record<string, { label: (r: Row) => string; cls: string }> = {
  routine: { label: () => ROUTINE_LABEL, cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  todo_pending: { label: () => "todo:pending", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  todo_approved: { label: () => "todo:approved", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  rejected: { label: (r) => `rejected → ${r.routed_name || "?"}`, cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" },
  assigned: { label: (r) => `assigned → ${r.routed_name || "?"}`, cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300" },
};

function formatDate(s: string): string {
  return new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function EscalatedPage() {
  const workspace = useWorkspace();
  const triageInProgress = useTriageInProgress();
  const [rows, setRows] = useState<Row[]>([]);
  const [chips, setChips] = useState<Chips | null>(null);
  const [uid, setUid] = useState("");
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<keyof Chips>("all");
  const [userPicked, setUserPicked] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/escalated")
      .then((r) => r.json())
      .then((d) => {
        setRows(d.tickets || []);
        setChips(d.chips || null);
        setUid(d.current_user_id || "");
        // Default chip: Awaiting approval if it has rows, else All.
        if (!userPicked) setActive((d.chips?.awaiting_approval || 0) > 0 ? "awaiting_approval" : "all");
      })
      .finally(() => setLoading(false));
  }, [userPicked]);

  useEffect(() => {
    load();
  }, [load, workspace.id]);

  const activeDef = CHIP_DEFS.find((c) => c.key === active)!;
  const filtered = rows.filter((r) => activeDef.match(r, uid));

  return (
    <div className="p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Escalated</h1>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Pipeline health for every escalated ticket. The{" "}
        <Link href="/dashboard/tickets/todos" className="underline">
          To Do
        </Link>{" "}
        queue is where you act; this is the at-a-glance view.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        {CHIP_DEFS.map((c) => (
          <button
            key={c.key}
            onClick={() => {
              setActive(c.key);
              setUserPicked(true);
            }}
            className={`rounded-full border px-3 py-1 text-sm ${
              active === c.key
                ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                : "border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
            }`}
          >
            {c.label} {chips ? `(${chips[c.key]})` : ""}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Nothing here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Subject</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Routed to</th>
                <th className="px-3 py-2 font-medium">Escalated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.map((r) => {
                const badge = ROUTED_BADGE[r.routed_to] || ROUTED_BADGE.routine;
                return (
                  <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
                    <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">{r.customer_name}</td>
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      <Link href={`/dashboard/tickets/${r.id}`} className="hover:underline">
                        {r.subject || "(no subject)"}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{r.escalation_reason || "—"}</td>
                    <td className="px-3 py-2">
                      {r.routed_to === "routine" ? (
                        <AiInvestigationBadge
                          escalatedAt={r.escalated_at}
                          escalatedTo={r.escalated_to}
                          triageInProgress={triageInProgress}
                          compact
                        />
                      ) : (
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                          {badge.label(r)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{formatDate(r.escalated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
