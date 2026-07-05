"use client";

/**
 * /god/[token] — the founder's SMS-linked god-mode cockpit.
 *
 * Phase 3 of docs/brain/specs/god-mode.md. Public token-authed page (no cookie,
 * no user; matches src/app/journey/[token]/page.tsx). Two tabs — Chat and
 * Approvals — both reading from GET /api/god/[token] on a 2.5s poll and
 * writing through POST /message + POST /approve.
 *
 * Invalid/disarmed token → 404 body; expired → 410 body; armed → cockpit.
 * Cockpit tears down via POST /api/god-mode/disarm { cockpit_token } — the
 * Phase-1 kill switch that flips status='disarmed' + nulls the token.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { GodModeChecklist, godCardTitle, DEC_STATUS_BADGE } from "@/components/god-mode-shared";

type Tab = "chat" | "approvals";

interface GodMessage { role: "user" | "assistant" | "system" | "checklist"; content: string; ts: string }
interface GodApproval {
  id: string;
  tool_name: string;
  preview: string;
  risk: "safe" | "write" | "destructive" | "plan" | "decision";
  status: "pending" | "approved" | "denied" | "asked";
  category: string | null;
  question_text: string | null;
  created_at: string;
  decided_at: string | null;
}
interface GodStandingGrant { category: string; created_at: string }
interface GodPayload {
  status: "armed" | "disarmed" | "expired";
  messages: GodMessage[];
  approvals: GodApproval[];
  standingGrants?: GodStandingGrant[];
  token_expires_at: string | null;
  absolute_expires_at: string | null;
}

const STATUS_BADGE = DEC_STATUS_BADGE;

export default function GodModeCockpit() {
  const { token } = useParams<{ token: string }>();
  const [tab, setTab] = useState<Tab>("chat");
  const [payload, setPayload] = useState<GodPayload | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "not_found" | "expired" | "error">("loading");
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [askDraft, setAskDraft] = useState<Record<string, string>>({});
  const [pinDraft, setPinDraft] = useState<Record<string, string>>({});
  const [dontAskDraft, setDontAskDraft] = useState<Record<string, boolean>>({});
  const [approvalError, setApprovalError] = useState<Record<string, string>>({});
  const [revoking, setRevoking] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/god/${token}`, { cache: "no-store" });
      if (r.status === 404) { setState("not_found"); return; }
      if (r.status === 410) { setState("expired"); return; }
      if (!r.ok) { setState("error"); return; }
      const j: GodPayload = await r.json();
      setPayload(j);
      setState("ok");
    } catch {
      setState("error");
    }
  }, [token]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 2500);
    return () => clearInterval(iv);
  }, [load]);

  // Auto-scroll transcript to bottom when new messages arrive.
  useEffect(() => {
    if (scrollRef.current && tab === "chat") scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [payload?.messages.length, tab]);

  const sortedApprovals = useMemo(() => {
    if (!payload) return [] as GodApproval[];
    return [...payload.approvals].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [payload]);

  const pendingCount = useMemo(
    () => (payload ? payload.approvals.filter((a) => a.status === "pending").length : 0),
    [payload],
  );

  async function sendMessage() {
    const text = composer.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/god/${token}/message`, {
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

  async function decideApproval(id: string, decision: "approve" | "deny" | "ask") {
    const approval = payload?.approvals.find((a) => a.id === id);
    if (!approval) return;
    setBusyApprovalId(id);
    setApprovalError((s) => ({ ...s, [id]: "" }));
    try {
      const body: { approvalId: string; decision: string; question?: string; pin?: string; dontAskAgain?: boolean } = {
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
        if (!pin) { setApprovalError((s) => ({ ...s, [id]: "PIN required to confirm." })); return; }
        body.pin = pin;
      }
      if (decision === "approve" && approval.risk === "decision" && dontAskDraft[id]) {
        body.dontAskAgain = true;
      }
      const r = await fetch(`/api/god/${token}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setAskDraft((s) => ({ ...s, [id]: "" }));
        setPinDraft((s) => ({ ...s, [id]: "" }));
        setDontAskDraft((s) => ({ ...s, [id]: false }));
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

  async function revokeStanding(category: string) {
    if (revoking) return;
    setRevoking(category);
    try {
      await fetch(`/api/god/${token}/standing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "revoke", category }),
      });
      await load();
    } finally {
      setRevoking(null);
    }
  }

  async function disarm() {
    if (!confirm("Disarm god-mode? The active session will be killed and the token invalidated.")) return;
    await fetch(`/api/god-mode/disarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cockpit_token: token }),
    });
    load();
  }

  // ── State branches ─────────────────────────────────────────────────────
  if (state === "loading") {
    return <FullPageMessage title="Loading god mode…" body="Verifying cockpit token." />;
  }
  if (state === "not_found") {
    return <FullPageMessage title="Not found" body="This cockpit link is invalid or the session was disarmed." />;
  }
  if (state === "expired") {
    return <FullPageMessage title="Session expired" body="Re-arm god mode from the ShopCX app to get a fresh cockpit link." />;
  }
  if (state === "error" || !payload) {
    return <FullPageMessage title="Something went wrong" body="Please refresh." />;
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto flex h-screen w-full max-w-3xl flex-col px-3 sm:px-6">
        {/* Header */}
        <header className="flex items-center justify-between py-3">
          <div>
            <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">God mode</h1>
            <p className="text-xs text-zinc-500">
              Session {payload.status === "armed" ? "armed" : payload.status}
              {payload.token_expires_at ? ` · idle-until ${new Date(payload.token_expires_at).toLocaleTimeString()}` : ""}
            </p>
          </div>
          <button
            onClick={disarm}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            Disarm
          </button>
        </header>

        {/* Tabs */}
        <div className="border-b border-zinc-200 dark:border-zinc-800">
          <nav className="-mb-px flex gap-6">
            {[
              { k: "chat", label: "Chat" },
              { k: "approvals", label: `Approvals${pendingCount > 0 ? ` (${pendingCount})` : ""}` },
            ].map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k as Tab)}
                className={`border-b-2 pb-2 text-sm font-medium ${
                  tab === t.k
                    ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                    : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Body */}
        {tab === "chat" && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto py-4">
              {payload.messages.length === 0 && (
                <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                  No messages yet. Type below to start the session.
                </div>
              )}
              {payload.messages.map((m, i) =>
                m.role === "checklist" ? (
                  <GodModeChecklist key={i} content={m.content} />
                ) : (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100"
                        : m.role === "system"
                          ? "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                          : "border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                    }`}
                  >
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                      {m.role === "user" ? "You" : m.role === "system" ? "Update" : "Chief of staff"}
                    </div>
                    {m.content}
                  </div>
                ),
              )}
            </div>
            <div className="border-t border-zinc-200 py-3 dark:border-zinc-800">
              <div className="flex gap-2">
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendMessage(); }
                  }}
                  rows={2}
                  placeholder="Type a message to the box… (⌘/Ctrl+Enter to send)"
                  disabled={sending}
                  className="min-h-[52px] flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                />
                <button
                  onClick={sendMessage}
                  disabled={sending || !composer.trim()}
                  className="self-stretch rounded-md bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sending ? "…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === "approvals" && (
          <div className="flex-1 space-y-3 overflow-y-auto py-4">
            {(payload.standingGrants ?? []).length > 0 && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  Standing approvals — god mode won&apos;t ask about these
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(payload.standingGrants ?? []).map((g) => (
                    <span
                      key={g.category}
                      className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                    >
                      {g.category}
                      <button
                        onClick={() => revokeStanding(g.category)}
                        disabled={revoking === g.category}
                        title="Ask me again about this"
                        className="ml-0.5 text-indigo-400 hover:text-indigo-700 disabled:opacity-50 dark:hover:text-indigo-200"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {sortedApprovals.length === 0 && (
              <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                Nothing needs you right now. God mode is working — it&apos;ll ask here only when it needs a real decision.
              </div>
            )}
            {sortedApprovals.map((a) => {
              const isPending = a.status === "pending";
              const isDestructive = a.risk === "destructive";
              const isDecision = a.risk === "decision";
              const err = approvalError[a.id];
              return (
                <div
                  key={a.id}
                  className={`rounded-lg border p-4 ${isDestructive ? "border-red-200 bg-red-50/40 dark:border-red-900/40 dark:bg-red-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {godCardTitle(a.risk)}
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-400">
                        {new Date(a.created_at).toLocaleTimeString()}
                        {a.decided_at ? ` · decided ${new Date(a.decided_at).toLocaleTimeString()}` : ""}
                        {a.category ? ` · ${a.category}` : ""}
                      </div>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[a.status]}`}>
                      {a.status}
                    </span>
                  </div>
                  {isDecision ? (
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-snug text-zinc-800 dark:text-zinc-200">{a.preview}</p>
                  ) : (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-xs text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
                      {a.preview}
                    </pre>
                  )}
                  {a.status === "asked" && a.question_text && (
                    <div className="mt-2 rounded border border-purple-200 bg-purple-50 p-2 text-xs text-purple-900 dark:border-purple-900 dark:bg-purple-950/40 dark:text-purple-200">
                      <span className="font-medium">You asked: </span>{a.question_text}
                    </div>
                  )}

                  {isPending && (
                    <div className="mt-3 space-y-2">
                      {isDestructive && (
                        <input
                          type="password"
                          inputMode="numeric"
                          autoComplete="off"
                          value={pinDraft[a.id] ?? ""}
                          onChange={(e) => setPinDraft((s) => ({ ...s, [a.id]: e.target.value }))}
                          placeholder="Enter your PIN to confirm"
                          disabled={busyApprovalId === a.id}
                          className="w-full rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 dark:border-red-900 dark:bg-zinc-900 dark:text-zinc-100"
                        />
                      )}
                      {isDecision && a.category && (
                        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                          <input
                            type="checkbox"
                            checked={!!dontAskDraft[a.id]}
                            onChange={(e) => setDontAskDraft((s) => ({ ...s, [a.id]: e.target.checked }))}
                            disabled={busyApprovalId === a.id}
                            className="h-3.5 w-3.5"
                          />
                          Don&apos;t ask again about this ({a.category})
                        </label>
                      )}
                      <textarea
                        rows={2}
                        value={askDraft[a.id] ?? ""}
                        onChange={(e) => setAskDraft((s) => ({ ...s, [a.id]: e.target.value }))}
                        placeholder="Or ask a question instead (optional)"
                        disabled={busyApprovalId === a.id}
                        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                      />
                      {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => decideApproval(a.id, "approve")}
                          disabled={busyApprovalId === a.id || (isDestructive && !(pinDraft[a.id] || "").trim())}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => decideApproval(a.id, "deny")}
                          disabled={busyApprovalId === a.id}
                          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                          Deny
                        </button>
                        <button
                          onClick={() => decideApproval(a.id, "ask")}
                          disabled={busyApprovalId === a.id || !(askDraft[a.id] || "").trim()}
                          className="rounded-md border border-purple-300 bg-white px-3 py-1.5 text-xs font-medium text-purple-700 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-purple-900 dark:bg-zinc-900 dark:text-purple-300 dark:hover:bg-purple-950"
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
      </div>
    </div>
  );
}

function FullPageMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-4 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm text-zinc-500">{body}</p>
      </div>
    </div>
  );
}
