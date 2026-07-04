"use client";

/**
 * GodModeTab — the in-app dashboard mirror of the /god/[token] cockpit.
 *
 * Phase 4 of docs/brain/specs/god-mode.md. Rendered inside the Developer
 * Message Center as a second tab; gated on `isOwner` at the parent (see
 * MessageCenterChat.tsx). Talks to owner-gated /api/god-mode/* routes — the
 * `cockpit_token` never leaves the server (the token remains reserved for
 * the SMS-linked /god/[token] cockpit).
 *
 * When nothing is armed: shows an Arm button. When armed: shows Disarm +
 * Chat + Approvals — same UX as the cockpit page, differences are:
 *   • No token in the URL (auth is the owner cookie).
 *   • Adds Arm / Disarm controls, since the tab is where the founder starts
 *     the session (the cockpit's Disarm is a kill-switch on an already-armed
 *     session).
 *
 * PIN, Ask, Deny behave identically to the cockpit — the server enforces
 * the same rails, and the client just relays them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface GodMessage { role: "user" | "assistant" | "system"; content: string; ts: string }
interface GodApproval {
  id: string;
  tool_name: string;
  preview: string;
  risk: "safe" | "write" | "destructive";
  status: "pending" | "approved" | "denied" | "asked";
  question_text: string | null;
  created_at: string;
  decided_at: string | null;
}
interface GodSession {
  id: string;
  status: "armed" | "disarmed" | "expired";
  token_expires_at: string | null;
  absolute_expires_at: string | null;
  armed_at: string;
}
interface GodPayload {
  armed: boolean;
  session?: GodSession;
  messages?: GodMessage[];
  approvals?: GodApproval[];
}

const RISK_BADGE: Record<GodApproval["risk"], string> = {
  safe: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  write: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  destructive: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const STATUS_BADGE: Record<GodApproval["status"], string> = {
  pending: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  denied: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  asked: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
};

export default function GodModeTab() {
  const [payload, setPayload] = useState<GodPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"arming" | "disarming" | null>(null);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [askDraft, setAskDraft] = useState<Record<string, string>>({});
  const [pinDraft, setPinDraft] = useState<Record<string, string>>({});
  const [approvalError, setApprovalError] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/god-mode/session`, { cache: "no-store" });
      if (!r.ok) { setLoading(false); return; }
      const j: GodPayload = await r.json();
      setPayload(j);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 2500);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [payload?.messages?.length]);

  const sortedApprovals = useMemo(() => {
    if (!payload?.approvals) return [] as GodApproval[];
    return [...payload.approvals].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [payload]);

  async function arm() {
    if (busy) return;
    setBusy("arming");
    try {
      const r = await fetch(`/api/god-mode/arm`, { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        alert(`Arm failed: ${j.error ?? r.statusText}`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function disarm() {
    if (busy) return;
    if (!confirm("Disarm god mode? The active session will be killed and its cockpit token invalidated.")) return;
    setBusy("disarming");
    try {
      await fetch(`/api/god-mode/disarm`, { method: "POST" });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage() {
    const text = composer.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/god-mode/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (r.ok) {
        setComposer("");
        load();
      } else {
        const j = await r.json().catch(() => ({}));
        alert(`Send failed: ${(j as { error?: string }).error ?? r.statusText}`);
      }
    } finally {
      setSending(false);
    }
  }

  async function decide(id: string, decision: "approve" | "deny" | "ask") {
    const approval = payload?.approvals?.find((a) => a.id === id);
    if (!approval) return;
    setBusyApprovalId(id);
    setApprovalError((s) => ({ ...s, [id]: "" }));
    try {
      const body: { approvalId: string; decision: string; question?: string; pin?: string } = {
        approvalId: id,
        decision,
      };
      if (decision === "ask") {
        const q = (askDraft[id] || "").trim();
        if (!q) { setApprovalError((s) => ({ ...s, [id]: "Type your question first." })); return; }
        body.question = q;
      }
      if (decision === "approve" && approval.risk === "destructive") {
        const pin = (pinDraft[id] || "").trim();
        if (!pin) { setApprovalError((s) => ({ ...s, [id]: "PIN required for destructive." })); return; }
        body.pin = pin;
      }
      const r = await fetch(`/api/god-mode/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setAskDraft((s) => ({ ...s, [id]: "" }));
        setPinDraft((s) => ({ ...s, [id]: "" }));
        load();
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        const err = j.error === "pin_incorrect" ? "PIN incorrect."
          : j.error === "pin_not_set" ? "No PIN set for this workspace."
          : j.error === "question_required" ? "Question required."
          : `Failed: ${j.error ?? r.statusText}`;
        setApprovalError((s) => ({ ...s, [id]: err }));
      }
    } finally {
      setBusyApprovalId(null);
    }
  }

  if (loading) return <div className="p-6 text-center text-xs text-zinc-400">Loading…</div>;

  // ── Not armed — show the Arm CTA. ─────────────────────────────────────
  if (!payload?.armed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">God mode is disarmed</div>
        <p className="max-w-md text-xs text-zinc-500">
          Arm to elevate a resumable box session with prod-write creds. Every non-safe tool call blocks on your approval (destructive requires your PIN). Auto-disarms after ~20 min idle; hard ceiling at 12 hours.
        </p>
        <button
          onClick={arm}
          disabled={busy !== null}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {busy === "arming" ? "Arming…" : "Arm god mode"}
        </button>
      </div>
    );
  }

  const messages = payload.messages ?? [];
  const session = payload.session!;
  const pendingCount = sortedApprovals.filter((a) => a.status === "pending").length;

  return (
    <div className="flex flex-1 flex-col">
      {/* Session header — status + Disarm */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-red-200 bg-red-50/40 px-2.5 py-1.5 dark:border-red-900/40 dark:bg-red-950/20">
        <div className="text-[11px] text-red-800 dark:text-red-300">
          <span className="font-semibold">GOD MODE ARMED</span>
          {session.token_expires_at ? ` · idle-until ${new Date(session.token_expires_at).toLocaleTimeString()}` : ""}
          {pendingCount > 0 ? ` · ${pendingCount} pending approval${pendingCount > 1 ? "s" : ""}` : ""}
        </div>
        <button
          onClick={disarm}
          disabled={busy !== null}
          className="rounded-md border border-red-300 bg-white px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950"
        >
          {busy === "disarming" ? "Disarming…" : "Disarm / kill"}
        </button>
      </div>

      {/* Approvals — pending first */}
      {sortedApprovals.length > 0 && (
        <div className="mb-3 space-y-2">
          {sortedApprovals.map((a) => {
            const isPending = a.status === "pending";
            const isDestructive = a.risk === "destructive";
            const err = approvalError[a.id];
            return (
              <div
                key={a.id}
                className="rounded-lg border border-zinc-200 bg-white p-2.5 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">{a.tool_name}</div>
                    <div className="mt-0.5 text-[10px] text-zinc-400">
                      {new Date(a.created_at).toLocaleTimeString()}
                      {a.decided_at ? ` · decided ${new Date(a.decided_at).toLocaleTimeString()}` : ""}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${RISK_BADGE[a.risk]}`}>{a.risk}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[a.status]}`}>{a.status}</span>
                  </div>
                </div>
                <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 text-[11px] text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                  {a.preview}
                </pre>
                {a.status === "asked" && a.question_text && (
                  <div className="mt-1.5 rounded border border-purple-200 bg-purple-50 p-1.5 text-[11px] text-purple-900 dark:border-purple-900 dark:bg-purple-950/40 dark:text-purple-200">
                    <span className="font-medium">You asked: </span>{a.question_text}
                  </div>
                )}
                {isPending && (
                  <div className="mt-2 space-y-1.5">
                    {isDestructive && (
                      <input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        value={pinDraft[a.id] ?? ""}
                        onChange={(e) => setPinDraft((s) => ({ ...s, [a.id]: e.target.value }))}
                        placeholder="PIN (required for destructive)"
                        disabled={busyApprovalId === a.id}
                        className="w-full rounded-md border border-red-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-900 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                    )}
                    <textarea
                      rows={2}
                      value={askDraft[a.id] ?? ""}
                      onChange={(e) => setAskDraft((s) => ({ ...s, [a.id]: e.target.value }))}
                      placeholder="Ask a question instead of deciding (optional)"
                      disabled={busyApprovalId === a.id}
                      className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    />
                    {err && <div className="text-[11px] text-red-600 dark:text-red-400">{err}</div>}
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        onClick={() => decide(a.id, "approve")}
                        disabled={busyApprovalId === a.id || (isDestructive && !(pinDraft[a.id] || "").trim())}
                        className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => decide(a.id, "deny")}
                        disabled={busyApprovalId === a.id}
                        className="rounded-md border border-zinc-300 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      >
                        Deny
                      </button>
                      <button
                        onClick={() => decide(a.id, "ask")}
                        disabled={busyApprovalId === a.id || !(askDraft[a.id] || "").trim()}
                        className="rounded-md border border-purple-300 bg-white px-2 py-0.5 text-[11px] font-medium text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-purple-900 dark:bg-zinc-900 dark:text-purple-300 dark:hover:bg-purple-950"
                      >
                        Ask
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Chat transcript */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-zinc-100 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        {messages.length === 0 && (
          <p className="py-6 text-center text-[11px] text-zinc-400">
            No messages yet. Type below to start the god-mode session.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap rounded-lg border px-2 py-1.5 text-xs ${
              m.role === "user"
                ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100"
                : m.role === "system"
                  ? "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                  : "border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            }`}
          >
            <div className="mb-0.5 text-[10px] uppercase tracking-wide text-zinc-400">{m.role}</div>
            {m.content}
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="mt-2 flex gap-2">
        <textarea
          rows={3}
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); } }}
          placeholder="Message the box under god-mode… (⌘/Ctrl+Enter to send)"
          disabled={sending}
          className="min-h-16 flex-1 resize-none rounded-md border border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
        />
        <button
          onClick={sendMessage}
          disabled={sending || !composer.trim()}
          className="self-end rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
        >
          {sending ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
