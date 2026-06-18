"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

type Msg = { role: "user" | "assistant"; content: string };

/**
 * Opus authoring chat — talk a feature through, then save it as docs/brain/specs/{slug}.md
 * (new) or refine an existing one (pass `slug`). Optionally queues a build. Owner-only.
 */
export default function AuthoringChat({ slug, triggerLabel }: { slug?: string; triggerLabel: string }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ slug: string; title: string; queued: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (workspace.role !== "owner") return null;

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next, slug, action: "chat" }),
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
        body: JSON.stringify({ messages, slug, action: "finalize", queueBuild }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "finalize failed");
      setResult({ slug: d.slug, title: d.title, queued: d.queued });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "finalize failed");
    } finally {
      setLoading(false);
    }
  }

  function close() {
    setOpen(false);
    setMessages([]);
    setInput("");
    setResult(null);
    setError(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
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
                {slug ? `Refine: ${slug}` : "New feature"}
              </h2>
              <button onClick={close} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">✕</button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {messages.length === 0 && !result && (
                <p className="py-6 text-center text-xs text-zinc-400">
                  {slug
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

            {!result && (
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
                    disabled={loading || !input.trim()}
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
