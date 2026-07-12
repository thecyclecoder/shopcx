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
import { GodModeChecklist, godCardTitle, DEC_STATUS_BADGE, EveAvatar, DirectorCockpitHeader } from "@/components/god-mode-shared";

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
  kind?: "god";
  status: "armed" | "disarmed" | "expired";
  messages: GodMessage[];
  approvals: GodApproval[];
  standingGrants?: GodStandingGrant[];
  token_expires_at: string | null;
  absolute_expires_at: string | null;
}

// director-sms-cockpit-per-director Phase 2: the payload shape returned by
// GET /api/god/<director-token>. Rendered by the SAME cockpit page — only the
// header + the transcript/approvals data source swap; the transcript +
// approvals subcomponents come from god-mode-shared.tsx unchanged.
interface DirectorCoachMsg { role: "user" | "assistant"; content: string }
interface DirectorCoachAction {
  id: string;
  type: string;
  summary: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  rail?: boolean;
}
interface DirectorPayload {
  kind: "director";
  thread: {
    id: string;
    director_function: string;
    messages: DirectorCoachMsg[];
    pending_actions: DirectorCoachAction[];
    turn_status: "idle" | "thinking" | "error";
    title: string | null;
  };
  persona: { name: string; accent: string; role: string };
  expires_at: string | null;
  absolute_expires_at: string | null;
}

type AnyPayload = GodPayload | DirectorPayload;

const STATUS_BADGE = DEC_STATUS_BADGE;

export default function GodModeCockpit() {
  const { token } = useParams<{ token: string }>();
  const [tab, setTab] = useState<Tab>("chat");
  const [payload, setPayload] = useState<AnyPayload | null>(null);
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
      const j: AnyPayload = await r.json();
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

  // Director / god narrowing — the payload union is discriminated on `kind`; a
  // legacy Eve payload omits `kind` (treated as 'god'). Keep memos + effects
  // guarded so a director payload never dereferences god-only fields.
  const godPayload: GodPayload | null =
    payload && (payload as { kind?: string }).kind !== "director" ? (payload as GodPayload) : null;
  const directorPayload: DirectorPayload | null =
    payload && (payload as { kind?: string }).kind === "director" ? (payload as DirectorPayload) : null;

  // Auto-scroll transcript to bottom when new messages arrive.
  useEffect(() => {
    if (scrollRef.current && tab === "chat") scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [godPayload?.messages.length, directorPayload?.thread.messages.length, tab]);

  const sortedApprovals = useMemo(() => {
    if (!godPayload) return [] as GodApproval[];
    return [...godPayload.approvals].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [godPayload]);

  const pendingCount = useMemo(
    () => (godPayload ? godPayload.approvals.filter((a) => a.status === "pending").length : 0),
    [godPayload],
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
    const approval = godPayload?.approvals.find((a) => a.id === id);
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
    if (!confirm("Send Eve home? This ends the chat and invalidates this link. You can pick it back up later from the app.")) return;
    await fetch(`/api/god-mode/disarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cockpit_token: token }),
    });
    load();
  }

  // director-sms-cockpit-per-director Phase 3: the director cockpit's decide
  // handler. Mirrors decideApproval's dispatch discipline (busy tracking, error
  // surface) but calls the SAME POST /api/god/[token]/approve endpoint — the
  // route's cockpit-resolver branch picks director vs god. PIN is only ever
  // required when the card carries `rail: true`.
  async function decideDirectorAction(actionId: string, decision: "approve" | "decline") {
    const card = directorPayload?.thread.pending_actions.find((a) => a.id === actionId);
    if (!card) return;
    setBusyApprovalId(actionId);
    setApprovalError((s) => ({ ...s, [actionId]: "" }));
    try {
      const body: { approvalId: string; decision: string; pin?: string } = { approvalId: actionId, decision };
      if (decision === "approve" && card.rail) {
        const pin = (pinDraft[actionId] || "").trim();
        if (!pin) {
          setApprovalError((s) => ({ ...s, [actionId]: "PIN required (rail action)." }));
          return;
        }
        body.pin = pin;
      }
      const r = await fetch(`/api/god/${token}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        setPinDraft((s) => ({ ...s, [actionId]: "" }));
        load();
      } else {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        const err = j.error === "pin_incorrect" ? "PIN incorrect."
          : j.error === "pin_required" ? "PIN required (rail action)."
          : `Failed: ${j.error ?? r.statusText}`;
        setApprovalError((s) => ({ ...s, [actionId]: err }));
      }
    } finally {
      setBusyApprovalId(null);
    }
  }

  async function sendDirectorMessage() {
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

  // ── State branches ─────────────────────────────────────────────────────
  if (state === "loading") {
    return <FullPageMessage title="Getting Eve…" body="One sec." />;
  }
  if (state === "not_found") {
    return <FullPageMessage title="Not found" body="This chat link is invalid or Eve's already clocked out." />;
  }
  if (state === "expired") {
    return <FullPageMessage title="Eve's clocked out" body="Tap her back in from the ShopCX app to pick up where you left off." />;
  }
  if (state === "error" || !payload) {
    return <FullPageMessage title="Something went wrong" body="Please refresh." />;
  }

  // director-sms-cockpit-per-director Phase 2: SAME cockpit page, director accent
  // header + leash subheader + persona-owned transcript/approvals. Reuses
  // GodModeChecklist + DEC_STATUS_BADGE + godCardTitle from god-mode-shared.tsx
  // so a fix in one is a fix in both. Eve's payload never reaches this branch,
  // so her existing render is byte-for-byte unchanged below.
  if (directorPayload) {
    const p = directorPayload;
    const sortedActions = [...p.thread.pending_actions].sort((a, b) => {
      if (a.status === "pending" && b.status !== "pending") return -1;
      if (a.status !== "pending" && b.status === "pending") return 1;
      return 0;
    });
    const leashSummary = `${p.persona.name} auto-approves in-leash actions; rail-hit calls require your PIN.`;
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="mx-auto flex h-screen w-full max-w-3xl flex-col px-3 sm:px-6">
          <DirectorCockpitHeader
            personaName={p.persona.name}
            personaAccent={p.persona.accent}
            personaRole={p.persona.role}
            leashSummary={leashSummary}
          />
          {/* Tabs — mirror Eve's cockpit chrome */}
          <div className="border-b border-zinc-200 dark:border-zinc-800">
            <nav className="-mb-px flex gap-6">
              {[
                { k: "chat", label: "Chat" },
                { k: "approvals", label: `Approvals${sortedActions.filter((a) => a.status === "pending").length > 0 ? ` (${sortedActions.filter((a) => a.status === "pending").length})` : ""}` },
              ].map((t) => (
                <button
                  key={t.k}
                  onClick={() => setTab(t.k as Tab)}
                  className={`border-b-2 pb-2 text-sm font-medium ${tab === t.k ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400" : "border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>
          {tab === "chat" && (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto py-4">
                {p.thread.messages.length === 0 && (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40">
                    Message {p.persona.name} to get started.
                  </div>
                )}
                {p.thread.messages.map((m, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100"
                        : "border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
                    }`}
                  >
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                      {m.role === "user" ? "You" : p.persona.name}
                    </div>
                    {m.content}
                  </div>
                ))}
              </div>
              <div className="border-t border-zinc-200 py-3 dark:border-zinc-800">
                <div className="flex gap-2">
                  <textarea
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendDirectorMessage(); }
                    }}
                    rows={2}
                    placeholder={`Message ${p.persona.name}… (⌘/Ctrl+Enter to send)`}
                    disabled={sending}
                    className="min-h-[52px] flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  />
                  <button
                    onClick={sendDirectorMessage}
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
              {sortedActions.length === 0 && (
                <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
                  Nothing needs you right now. {p.persona.name} is handling in-leash calls herself.
                </div>
              )}
              {sortedActions.map((a) => {
                const isPending = a.status === "pending";
                const isRail = !!a.rail;
                const err = approvalError[a.id];
                return (
                  <div
                    key={a.id}
                    className={`rounded-lg border p-4 ${isRail ? "border-red-200 bg-red-50/40 dark:border-red-900/40 dark:bg-red-950/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                          {isRail ? godCardTitle("destructive") : godCardTitle("decision")}
                        </div>
                        <div className="mt-0.5 text-[11px] text-zinc-400">
                          {a.type}
                          {isRail ? " · rail" : ""}
                        </div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${DEC_STATUS_BADGE[a.status] ?? DEC_STATUS_BADGE.pending}`}>
                        {a.status}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-snug text-zinc-800 dark:text-zinc-200">{a.summary}</p>
                    {isPending && (
                      <div className="mt-3 space-y-2">
                        {isRail && (
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
                        {err && <div className="text-xs text-red-600 dark:text-red-400">{err}</div>}
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => decideDirectorAction(a.id, "approve")}
                            disabled={busyApprovalId === a.id || (isRail && !(pinDraft[a.id] || "").trim())}
                            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => decideDirectorAction(a.id, "decline")}
                            disabled={busyApprovalId === a.id}
                            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            Decline
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

  // ── Eve branch — the original god-mode cockpit render (unchanged) ──────────
  const eve = godPayload!;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto flex h-screen w-full max-w-3xl flex-col px-3 sm:px-6">
        {/* Header */}
        <header className="flex items-center justify-between py-3">
          <div className="flex items-center gap-2.5">
            <EveAvatar size={38} />
            <div>
              <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">Eve</h1>
              <p className="text-xs text-zinc-500">
                {eve.status === "armed" ? "Online" : "Clocked out"}
                {eve.status === "armed" && eve.token_expires_at ? ` · here till ${new Date(eve.token_expires_at).toLocaleTimeString()} if idle` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={disarm}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            Send home
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
              {eve.messages.length === 0 && (
                <div className="flex items-center gap-2.5 rounded-lg border border-amber-200 bg-amber-50/50 p-4 text-sm text-zinc-600 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-zinc-300">
                  <EveAvatar size={32} />
                  <span>Hey you 😌 What do you need? Just tell me and I&apos;ll take care of it.</span>
                </div>
              )}
              {eve.messages.map((m, i) =>
                m.role === "checklist" ? (
                  <GodModeChecklist key={i} content={m.content} />
                ) : m.role === "assistant" ? (
                  <div key={i} className="flex items-start gap-2">
                    <EveAvatar size={28} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-amber-500 dark:text-amber-400">Eve</div>
                      <div className="whitespace-pre-wrap rounded-lg rounded-tl-none border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
                        {m.content}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100"
                        : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
                    }`}
                  >
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-400">
                      {m.role === "user" ? "You" : "Update"}
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
                  placeholder="Message Eve… (⌘/Ctrl+Enter to send)"
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
            {(eve.standingGrants ?? []).length > 0 && (
              <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                <div className="mb-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                  Standing approvals — Eve won&apos;t ask about these
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(eve.standingGrants ?? []).map((g) => (
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
                Nothing needs you right now, babe. Eve&apos;s handling it — she&apos;ll only ping you here when it&apos;s a real call.
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
