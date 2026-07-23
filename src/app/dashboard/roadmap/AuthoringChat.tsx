"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { useBoxLive } from "@/lib/use-box-live";

type Msg = { role: "user" | "assistant"; content: string };
type Session = {
  id: string;
  title: string | null;
  spec_slug: string | null;
  messages: Msg[];
  status: "active" | "finalized";
  turn_status: "idle" | "thinking" | "error";
  last_error: string | null;
  updated_at: string;
};

/**
 * Box-hosted authoring chat (box-spec-chat) — three modes, the chat now runs on the build box as a
 * long-running, resumable `claude -p` session on Max (full repo + brain + WebSearch every turn), NOT
 * the Anthropic API:
 *  - new:    talk a feature through → save docs/brain/specs/{slug}.md
 *  - refine: pass `slug` → edit an existing spec
 *  - seed ("New spec from brain"): pass `seed` + `seedSlug` (a brain page) → draft a fresh spec to extend it.
 *
 * Each turn POSTs to /api/roadmap/chat (which appends the message + enqueues a box job) and then POLLS
 * GET /api/roadmap/chat-session?id= every ~3s while `turn_status='thinking'`; the reply lands when the
 * box finishes (minutes, not seconds — signposted). The DB (public.roadmap_chats) is the source of truth
 * for the transcript + resume list, so closing the modal keeps the thread and it resumes cross-device.
 * On a box error the composer surfaces a Retry (re-resumes the same box session). Owner-only.
 */
export default function AuthoringChat({
  slug,
  triggerLabel,
  seed = false,
  seedSlug,
}: {
  slug?: string;
  triggerLabel: string;
  seed?: boolean;
  seedSlug?: string;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false); // a turn is on the box
  const [finalizing, setFinalizing] = useState(false); // a finalize is on the box
  const [result, setResult] = useState<{ slug: string; title: string; queued: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false); // box error → offer Retry (re-resume the session)
  const [seedValue, setSeedValue] = useState(seedSlug || "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resume, setResume] = useState<{ candidate: Session | null; recent: Session[] } | null>(null);
  const queueBuildRef = useRef(false); // what the in-flight finalize requested (for the result line)

  if (workspace.role !== "owner") return null;

  const activeSeed = seed ? (seedSlug || seedValue.trim()) : undefined;
  const seedReady = !seed || !!activeSeed;
  const busy = thinking || finalizing;

  // Mirror the thread while a turn/finalize is on the box. The box owns the transcript; we clear the
  // spinner when turn_status returns to idle (or surface a Retry on error).
  //
  // roadmap-box-broadcast: was a 3s poll. Now event-driven via useBoxLive — the box's write to
  // roadmap_chats (turn complete) broadcasts on box:<ws>, so the reply lands the instant the box
  // finishes rather than up to 3s later. A 3s backstop stays (same as the old cadence) so a missed
  // broadcast never hangs the spinner, and we fire one tick on turn-start for the current state.
  const tick = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/roadmap/chat-session?id=${encodeURIComponent(sessionId)}`);
      const d = await res.json();
      const s = d.session as Session | null;
      if (!s) return;
      setMessages(s.messages);
      if (s.turn_status === "error") {
        setError(s.last_error || "The box turn failed.");
        setRetryable(true);
        setThinking(false);
        setFinalizing(false);
        return;
      }
      if (s.turn_status === "idle") {
        if (finalizing && s.status === "finalized" && s.spec_slug) {
          setResult({ slug: s.spec_slug, title: (s.title || s.spec_slug).replace(/^Refine:\s*/, ""), queued: queueBuildRef.current });
          setFinalizing(false);
          router.refresh();
        } else if (!finalizing) {
          setThinking(false);
        }
      }
    } catch {
      // transient — the backstop / next broadcast retries
    }
  }, [sessionId, finalizing, router]);

  const chatActive = open && !!sessionId && busy;
  useBoxLive(tick, { enabled: chatActive, backstopMs: 3_000 });
  // Fetch current state the moment a turn starts (useBoxLive only fires on events/backstop).
  useEffect(() => {
    if (chatActive) void tick();
  }, [chatActive, tick]);

  async function openChat() {
    setOpen(true);
    setError(null);
    setRetryable(false);
    if (seed) return; // seed mode drafts fresh from a brain page — no prior session to resume
    try {
      if (slug) {
        const res = await fetch(`/api/roadmap/chat-session?slug=${encodeURIComponent(slug)}`);
        const d = await res.json();
        if (d.session?.messages?.length) setResume({ candidate: d.session as Session, recent: [] });
      } else {
        const res = await fetch("/api/roadmap/chat-session");
        const d = await res.json();
        const recent = ((d.sessions as Session[]) || []).filter((s) => s.messages?.length);
        if (recent.length) setResume({ candidate: null, recent });
      }
    } catch {
      // no resume options — just start fresh
    }
  }

  function resumeSession(s: Session) {
    setMessages(s.messages);
    setSessionId(s.id);
    setResume(null);
    setError(null);
    setRetryable(false);
    if (s.turn_status === "thinking") setThinking(true); // a turn was mid-flight on another device
  }

  function startFresh() {
    setMessages([]);
    setSessionId(null);
    setResume(null);
    setError(null);
    setRetryable(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !seedReady) return;
    setMessages((m) => [...m, { role: "user", content: text }]); // optimistic — the poll re-syncs from DB
    setInput("");
    setThinking(true);
    setError(null);
    setRetryable(false);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId ?? undefined, message: text, slug, seedSlug: activeSeed, action: "chat" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "chat failed");
      if (d.session) {
        setSessionId(d.session.id);
        setMessages(d.session.messages);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
      setRetryable(!!sessionId);
      setThinking(false);
    }
  }

  async function retry() {
    if (busy || !sessionId) return;
    setThinking(true);
    setError(null);
    setRetryable(false);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, slug, seedSlug: activeSeed, action: "retry" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "retry failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "retry failed");
      setRetryable(true);
      setThinking(false);
    }
  }

  async function finalize(queueBuild: boolean) {
    if (busy || messages.length === 0 || !sessionId) return;
    queueBuildRef.current = queueBuild;
    setFinalizing(true);
    setError(null);
    setRetryable(false);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, slug, seedSlug: activeSeed, action: "finalize", queueBuild }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "finalize failed");
      // result lands via the poll when turn_status→idle + status→finalized.
    } catch (e) {
      setError(e instanceof Error ? e.message : "finalize failed");
      setFinalizing(false);
    }
  }

  function close() {
    // The transcript lives in the DB (server-owned), so closing only clears local UI state.
    setOpen(false);
    setMessages([]);
    setInput("");
    setThinking(false);
    setFinalizing(false);
    setResult(null);
    setError(null);
    setRetryable(false);
    setSessionId(null);
    setResume(null);
    if (!seedSlug) setSeedValue("");
  }

  return (
    <>
      <button
        type="button"
        onClick={openChat}
        className="rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-900/40 dark:bg-indigo-950/30 dark:text-indigo-300"
      >
        {triggerLabel}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={close}>
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl dark:bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {seed ? "New spec from brain" : slug ? `Refine: ${slug}` : "New feature"}
              </h2>
              <button onClick={close} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">✕</button>
            </div>

            {resume ? (
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {resume.candidate ? (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900/40 dark:bg-indigo-950/20">
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                      You have an in-progress chat for this spec ({resume.candidate.messages.length} messages, last updated{" "}
                      {new Date(resume.candidate.updated_at).toLocaleString()}).
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => resumeSession(resume.candidate!)}
                        className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700"
                      >
                        Resume chat
                      </button>
                      <button
                        onClick={startFresh}
                        className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
                      >
                        Start fresh
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">Resume a recent chat, or start a new one:</p>
                    <div className="space-y-1.5">
                      {resume.recent.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => resumeSession(s)}
                          className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                        >
                          <div className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-200">
                            {s.title || s.spec_slug || "Untitled chat"}
                          </div>
                          <div className="text-[11px] text-zinc-400">
                            {s.messages.length} messages · {new Date(s.updated_at).toLocaleString()}
                          </div>
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={startFresh}
                      className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300"
                    >
                      Start fresh
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {seed && !seedSlug && messages.length === 0 && !result && (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-2.5 dark:border-zinc-700 dark:bg-zinc-950">
                    <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
                      Brain page to seed from (slug, no <code>.md</code>):
                    </label>
                    <input
                      value={seedValue}
                      onChange={(e) => setSeedValue(e.target.value)}
                      placeholder="e.g. lifecycles/roadmap-build-console · dashboard/tickets · tables/agent_jobs"
                      className="mt-1 w-full rounded-md border border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    />
                  </div>
                )}
                {messages.length === 0 && !result && (
                  <p className="py-6 text-center text-xs text-zinc-400">
                    {seed
                      ? "Opus-on-Max reads the current brain page + the real code and drafts a fresh spec to extend or fix it. Set the page above, then describe what to change or add."
                      : slug
                      ? "Describe what to change or add to this spec. Opus-on-Max reads the repo + brain to refine it; then Save."
                      : "Describe the feature you want. Opus-on-Max reads the code, the brain, and the web, asks questions, and shapes a spec; then Save (and optionally build it)."}
                  </p>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                    <div
                      className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-xs ${
                        m.role === "user"
                          ? "bg-indigo-600 text-white"
                          : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
                {busy && (
                  <p className="text-center text-xs text-zinc-400">
                    {finalizing ? "Finalizing on the box…" : "Thinking on the box…"} (this takes a minute — it reads the repo + web on Max)
                  </p>
                )}
                {result && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
                    Saved <strong>{result.title || result.slug}</strong> to <code>specs/{result.slug}.md</code>
                    {result.queued ? " and queued a build." : "."}{" "}
                    <a href={`/dashboard/roadmap/${result.slug}`} className="underline">View spec →</a>
                  </div>
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
            )}

            {!result && !resume && (
              <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
                <div className="flex gap-2">
                  <textarea
                    rows={2}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                    }}
                    placeholder="Type… (⌘/Ctrl+Enter to send)"
                    className="flex-1 resize-none rounded-md border border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <button
                    onClick={send}
                    disabled={busy || !input.trim() || !seedReady}
                    className="self-end rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
                  >
                    Send
                  </button>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => finalize(false)}
                    disabled={busy || messages.length === 0}
                    className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Save spec
                  </button>
                  <button
                    onClick={() => finalize(true)}
                    disabled={busy || messages.length === 0}
                    className="rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Save &amp; build
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
