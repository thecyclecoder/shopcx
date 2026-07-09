"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import GodModeTab from "./GodModeTab";

// Owner-only tabs — the message-center default 'chat' is the founder's read-only console;
// 'god' is the Phase-4 elevated god-mode mirror (docs/brain/specs/god-mode.md).
type Tab = "chat" | "god";

type Msg = { role: "user" | "assistant"; content: string };
type Action = {
  id: string;
  type: "run_prod_script" | "spec";
  summary: string;
  cmd?: string;
  preview?: string;
  spec?: { slug: string; title?: string; owner?: string; parent?: string };
  payload?: { queueBuild?: boolean };
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
};
type Thread = {
  id: string;
  title: string | null;
  messages: Msg[];
  turn_status: "idle" | "thinking" | "error";
  last_error: string | null;
  pending_actions: Action[];
  updated_at: string;
};

/**
 * Developer Message Center (developer-message-center) — a founder-facing, read-only "ask the box
 * anything" console. Each turn POSTs to /api/developer/messages (which appends the message + enqueues a
 * kind='dev-ask' box job) then POLLS GET ?id= every ~3s while turn_status='thinking'; the reply lands
 * when the box finishes on Max (minutes, not seconds — signposted). The box has the whole brain + repo +
 * read-only prod DB + WebSearch. Reads are silent; any proposed DB write / spec handoff renders as an
 * inline approval card (Approve/Dismiss). Owner-only.
 */
export default function MessageCenterChat() {
  const workspace = useWorkspace();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [recent, setRecent] = useState<Thread[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer with its content (within max-h-64), so a long Report Issue / question isn't
  // cramped into a 2-row box. Resets back to the min height when the input is cleared after a send.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const isOwner = workspace.role === "owner";

  const loadRecent = useCallback(async () => {
    try {
      const res = await fetch("/api/developer/messages");
      const d = await res.json();
      setRecent(((d.threads as Thread[]) || []).filter((t) => t.messages?.length));
    } catch {
      /* no resume options */
    }
  }, []);

  useEffect(() => {
    if (isOwner) void loadRecent();
  }, [isOwner, loadRecent]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, actions, thinking]);

  // Poll the thread while a turn is on the box; mirror the transcript + cards, clear the spinner on idle.
  useEffect(() => {
    if (!threadId || !thinking) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/developer/messages?id=${encodeURIComponent(threadId)}`);
        const d = await res.json();
        const t = d.thread as Thread | null;
        if (!t || stop) return;
        setMessages(t.messages);
        setActions(t.pending_actions || []);
        if (t.turn_status === "error") {
          setError(t.last_error || "The box turn failed.");
          setRetryable(true);
          setThinking(false);
          return;
        }
        if (t.turn_status === "idle") {
          setThinking(false);
          void loadRecent();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    const handle = setInterval(tick, 3000);
    void tick();
    return () => { stop = true; clearInterval(handle); };
  }, [threadId, thinking, loadRecent]);

  if (!isOwner) {
    return <p className="p-6 text-sm text-zinc-500">The Message Center is available to the workspace owner only.</p>;
  }

  function resumeThread(t: Thread) {
    setThreadId(t.id);
    setMessages(t.messages);
    setActions(t.pending_actions || []);
    setError(null);
    setRetryable(false);
    if (t.turn_status === "thinking") setThinking(true);
  }

  function startFresh() {
    setThreadId(null);
    setMessages([]);
    setActions([]);
    setError(null);
    setRetryable(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    setMessages((m) => [...m, { role: "user", content: text }]); // optimistic — the poll re-syncs
    setActions([]);
    setInput("");
    setThinking(true);
    setError(null);
    setRetryable(false);
    try {
      const res = await fetch("/api/developer/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: threadId ?? undefined, message: text, action: "chat" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "send failed");
      if (d.thread) {
        setThreadId(d.thread.id);
        setMessages(d.thread.messages);
        setActions(d.thread.pending_actions || []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
      setRetryable(!!threadId);
      setThinking(false);
    }
  }

  async function retry() {
    if (thinking || !threadId) return;
    setThinking(true);
    setError(null);
    setRetryable(false);
    try {
      const res = await fetch("/api/developer/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: threadId, action: "retry" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "retry failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "retry failed");
      setRetryable(true);
      setThinking(false);
    }
  }

  async function decide(actionId: string, decision: "approve" | "decline") {
    if (!threadId || approvingId) return;
    setApprovingId(actionId);
    try {
      const res = await fetch("/api/developer/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: threadId, actionId, decision, action: "approve" }),
      });
      const d = await res.json();
      if (d.thread) {
        setActions(d.thread.pending_actions || []);
        if (decision === "approve" && d.thread.turn_status === "thinking") setThinking(true);
      }
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-3rem)] w-full max-w-3xl flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Message Center</h1>
          <p className="text-[11px] text-zinc-500">
            Ask the box anything — it reads the brain, the repo, the prod DB (read-only), and the web on Max. Report-back, never a builder.
          </p>
        </div>
        <button
          onClick={startFresh}
          className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
        >
          New thread
        </button>
      </div>

      {/* Phase-4 god-mode tab: shown ONLY to the workspace owner. The parent gate here
          is UX-level; the /api/god-mode/* endpoints RE-gate via requireOwner server-side. */}
      {isOwner && (
        <div className="mb-3 border-b border-zinc-200 dark:border-zinc-800">
          <nav className="-mb-px flex gap-6">
            {[
              { k: "chat", label: "Chat" },
              { k: "god", label: "Eve" },
            ].map((t) => (
              <button
                key={t.k}
                onClick={() => setTab(t.k as Tab)}
                className={`border-b-2 pb-2 text-xs font-medium ${
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
      )}

      {isOwner && tab === "god" ? (
        <GodModeTab />
      ) : (
      <>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-100 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="py-2 text-center text-xs text-zinc-400">
              Investigate (&quot;does {`{feature}`} work right now?&quot;), pull ad-hoc analysis (&quot;how many storefront sessions had add-to-carts last week?&quot;), or plan a spec against the goals. Reads run silently; any write or spec stops at an approval card.
            </p>
            {recent.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-zinc-500">Recent threads</p>
                {recent.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => resumeThread(t)}
                    className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">{t.title || "Untitled thread"}</div>
                    <div className="text-[11px] text-zinc-400">{t.messages.length} messages · {new Date(t.updated_at).toLocaleString()}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs ${
                m.role === "user" ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}

        {/* Inline approval cards — any proposed DB write / spec handoff. Reads never produce one. */}
        {actions.filter((a) => a.status === "pending").length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/40 p-2 dark:border-amber-900/40 dark:bg-amber-950/20">
            <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">Needs your approval — nothing changes until you click:</div>
            {actions.filter((a) => a.status === "pending").map((a) => (
              <div key={a.id} className="rounded border border-amber-100 bg-white p-2 dark:border-amber-900/30 dark:bg-zinc-900">
                <div className="text-[11px] font-medium text-zinc-800 dark:text-zinc-200">
                  {a.type === "spec" ? "📄 Spec handoff" : "🗄️ Database write"} — {a.summary}
                  {a.type === "spec" && a.payload?.queueBuild ? " (and build)" : ""}
                </div>
                {(a.preview || a.cmd) && (
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-1.5 text-[10px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{a.preview || a.cmd}</pre>
                )}
                <div className="mt-1.5 flex gap-2">
                  <button
                    onClick={() => decide(a.id, "approve")}
                    disabled={approvingId !== null || thinking}
                    className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {approvingId === a.id ? "…" : a.type === "spec" ? (a.payload?.queueBuild ? "Send & build" : "Send to spec") : "Approve & apply"}
                  </button>
                  <button
                    onClick={() => decide(a.id, "decline")}
                    disabled={approvingId !== null || thinking}
                    className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {actions.filter((a) => a.status !== "pending").map((a) => (
          <div key={a.id} className="text-left">
            <div className="inline-block rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950">
              {a.summary} → <span className={a.status === "done" ? "text-emerald-600" : a.status === "failed" ? "text-rose-500" : ""}>{a.status}</span>
              {a.result ? ` · ${a.result.slice(0, 160)}` : ""}
            </div>
          </div>
        ))}

        {thinking && (
          <p className="text-center text-xs text-zinc-400">Thinking on the box… (this takes a minute — it reads the repo + DB + web on Max)</p>
        )}
        {error && (
          <div className="text-center text-xs text-rose-500">
            {error}
            {retryable && (
              <button onClick={retry} className="ml-2 rounded border border-rose-300 px-2 py-0.5 font-medium text-rose-600 hover:bg-rose-50 dark:border-rose-900/40 dark:hover:bg-rose-950/20">
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3">
        <div className="flex gap-2">
          <textarea
            ref={composerRef}
            rows={5}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }}
            placeholder="Ask the box… (⌘/Ctrl+Enter to send)"
            className="min-h-28 max-h-64 flex-1 resize-none overflow-auto rounded-md border border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          <button
            onClick={send}
            disabled={thinking || !input.trim()}
            className="self-end rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
          >
            Send
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
