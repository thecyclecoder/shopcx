"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

type Msg = { role: "user" | "assistant"; content: string };
type Session = {
  id: string;
  title: string | null;
  spec_slug: string | null;
  messages: Msg[];
  updated_at: string;
};

/**
 * Opus authoring chat — three modes, all Opus-grounded in the brain (POST /api/roadmap/chat):
 *  - new:    talk a feature through → save docs/brain/specs/{slug}.md
 *  - refine: pass `slug` → edit an existing spec
 *  - seed ("New spec from brain" / re-hydrate): pass `seed` + an optional `seedSlug` (a brain page —
 *    lifecycle/dashboard/table or an archived entry). Opus reads the CURRENT brain page and drafts a
 *    FRESH spec to extend/fix it (never reactivates a stale snapshot). If no seedSlug, asks for one.
 *
 * Conversations persist to public.roadmap_chats (POST/GET /api/roadmap/chat-session) — the transcript
 * autosaves (debounced) as you talk, survives closing the modal, and resumes cross-device. On open we
 * offer Resume vs Start fresh (refine: the spec's latest active session; new: a recent-chats list).
 * Finalizing marks the session finalized + links its slug. Owner-only.
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
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ slug: string; title: string; queued: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seedValue, setSeedValue] = useState(seedSlug || "");
  // Persistence: the row id (set once a session exists) + the resume picker (null = proceed to chat).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resume, setResume] = useState<{ candidate: Session | null; recent: Session[] } | null>(null);
  const persisting = useRef(false);

  if (workspace.role !== "owner") return null;

  // In seed mode the effective brain page comes from the prop (archived entry) or the input box.
  const activeSeed = seed ? (seedSlug || seedValue.trim()) : undefined;
  const seedReady = !seed || !!activeSeed;

  // Persist the transcript (upsert). Serialized via persisting ref so the debounced autosave can't
  // race itself into duplicate rows before the first insert returns an id.
  async function persist(status?: "active" | "finalized", finalSlug?: string): Promise<string | undefined> {
    if (persisting.current || messages.length === 0) return sessionId ?? undefined;
    persisting.current = true;
    try {
      const title = slug
        ? `Refine: ${slug}`
        : messages.find((m) => m.role === "user")?.content.slice(0, 80) || "New feature";
      const res = await fetch("/api/roadmap/chat-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sessionId ?? undefined,
          spec_slug: finalSlug ?? slug ?? null,
          title,
          messages,
          status,
        }),
      });
      const d = await res.json();
      if (res.ok && d.id) {
        if (!sessionId) setSessionId(d.id);
        return d.id as string;
      }
    } catch {
      // best-effort — a failed autosave shouldn't interrupt the chat
    } finally {
      persisting.current = false;
    }
    return sessionId ?? undefined;
  }

  // Debounced autosave as the conversation progresses (not while picking a resume, post-finalize, or empty).
  useEffect(() => {
    if (!open || resume || result || messages.length === 0) return;
    const handle = setTimeout(() => void persist(), 800);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, open, resume, result]);

  async function openChat() {
    setOpen(true);
    setError(null);
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
  }

  function startFresh() {
    setMessages([]);
    setSessionId(null);
    setResume(null);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading || !seedReady) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, slug, seedSlug: activeSeed, action: "chat" }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "chat failed");
      setMessages((m) => [...m, { role: "assistant", content: d.reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "chat failed");
    } finally {
      setLoading(false);
    }
  }

  async function finalize(queueBuild: boolean) {
    if (loading || messages.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, slug, seedSlug: activeSeed, action: "finalize", queueBuild }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "finalize failed");
      setResult({ slug: d.slug, title: d.title, queued: d.queued });
      // Mark the session finalized + link its now-known slug (matters for New-feature chats).
      void persist("finalized", d.slug);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "finalize failed");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    // Persist (don't discard) the in-progress transcript, then clear only local UI state.
    if (open && !result) void persist();
    setOpen(false);
    setMessages([]);
    setInput("");
    setResult(null);
    setError(null);
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
                      ? "Opus reads the current brain page and drafts a fresh spec to extend or fix it — not a stale snapshot. Set the page above, then describe what to change or add."
                      : slug
                      ? "Describe what to change or add to this spec. Opus will refine it; then Save."
                      : "Describe the feature you want. Opus will ask questions and shape a spec; then Save (and optionally build it)."}
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
                {loading && <p className="text-center text-xs text-zinc-400">Opus is thinking…</p>}
                {result && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300">
                    Saved <strong>{result.title || result.slug}</strong> to <code>specs/{result.slug}.md</code>
                    {result.queued ? " and queued a build." : "."}{" "}
                    <a href={`/dashboard/roadmap/${result.slug}`} className="underline">View spec →</a>
                  </div>
                )}
                {error && <p className="text-center text-xs text-rose-500">{error}</p>}
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
                    disabled={loading || !input.trim() || !seedReady}
                    className="self-end rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
                  >
                    Send
                  </button>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => finalize(false)}
                    disabled={loading || messages.length === 0}
                    className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Save spec
                  </button>
                  <button
                    onClick={() => finalize(true)}
                    disabled={loading || messages.length === 0}
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
