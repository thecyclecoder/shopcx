"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// CEO↔Director coaching chat (worker-grading-and-director-management Phase 7). A resumable Max
// conversation with the Platform/DevOps Director (Ada): the CEO asks "why haven't you built spec X?",
// she explains read-only, and the CEO coaches her. TWO explicit buttons resolve "is this a chat or a
// directive?": ASK (she explains, never writes a rule) vs COACH HER (distills the directive into a
// durable director_instruction → an approval card → on approve it's injected into her future decisions).
// Each turn POSTs /api/director/coach then polls GET ?id= while turn_status='thinking'. Owner-only.

type Msg = { role: "user" | "assistant"; content: string };
type Action = {
  id: string;
  // spec-status is intentionally absent — it's auto-applied and never renders as a card
  // (ada-director-spec-status-cards Phase 1 revised). The flip shows up in the chat reply text + audit trail.
  type: "coaching" | "spec" | "goal" | "spec-edit" | "directive";
  summary: string;
  errorClass?: string;
  guidance?: string;
  reasoning?: string;
  slug?: string;
  title?: string;
  outcome?: string;
  content?: string;
  steps?: string[];
  gateBuildsUntil?: string;
  criticalSpecs?: string[];
  holdBuilds?: string[];
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
};
type Thread = {
  id: string;
  messages: Msg[];
  turn_status: "idle" | "thinking" | "error";
  last_error: string | null;
  pending_actions: Action[];
  source?: "web" | "slack";
  director_function?: string;
};

/**
 * Renders the coach/ask/plan chat for ONE director. `directorFunction` picks which director this thread
 * runs AS (validated live+leashed server-side); absent → 'platform' (the legacy Ask-Ada page, unchanged).
 * `directorName` only drives display copy. The Message Center mounts one instance per director tab (keyed
 * on the slug so switching tabs is a clean remount).
 */
export function DirectorCoachChat({
  directorFunction,
  directorName,
}: { directorFunction?: string; directorName?: string } = {}) {
  const dirFn = directorFunction ?? "platform";
  const name = directorName ?? "Ada";
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"web" | "slack">("web");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, actions, thinking]);

  // Resume on mount: the conversation lives in the DB (director_coach_threads), so load the most recent
  // thread instead of showing a blank box on every re-render/refresh. If a turn is still mid-flight, resume
  // polling for it. (Without this the chat appeared not to "persist" even though the box had answered.)
  const loadLatest = useCallback(async () => {
    try {
      const res = await fetch("/api/director/coach");
      const d = await res.json();
      const threads = (d.threads as Thread[]) || [];
      // Resume only THIS director's most recent thread — the list endpoint returns every director's
      // threads, so a tab must not adopt another director's conversation.
      const latest = threads.find((t) => t.messages?.length && (t.director_function ?? "platform") === dirFn);
      if (latest) {
        setThreadId(latest.id);
        setMessages(latest.messages);
        setActions(latest.pending_actions || []);
        setSource(latest.source === "slack" ? "slack" : "web");
        if (latest.turn_status === "thinking") setThinking(true);
      }
    } catch {
      /* nothing to resume */
    }
  }, [dirFn]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Poll while a turn is on the box.
  useEffect(() => {
    if (!threadId || !thinking) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/director/coach?id=${encodeURIComponent(threadId)}`);
        const d = await res.json();
        const t = d.thread as Thread | null;
        if (!t || stop) return;
        setMessages(t.messages);
        setActions(t.pending_actions || []);
        if (t.source) setSource(t.source);
        if (t.turn_status === "error") {
          setError(t.last_error || "The box turn failed.");
          setThinking(false);
        } else if (t.turn_status === "idle") {
          setThinking(false);
        }
      } catch {
        /* transient — keep polling */
      }
    };
    const handle = setInterval(tick, 3000);
    void tick();
    return () => {
      stop = true;
      clearInterval(handle);
    };
  }, [threadId, thinking]);

  const send = useCallback(
    async (intent: "ask" | "coach" | "plan") => {
      const text = input.trim();
      if (!text || thinking) return;
      setInput("");
      setError(null);
      setMessages((m) => [...m, { role: "user", content: text }]);
      setThinking(true);
      try {
        const res = await fetch("/api/director/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // director_function is only read when starting a new thread (id absent); ignored on continuation.
          body: JSON.stringify({ id: threadId ?? undefined, message: text, action: "chat", intent, director_function: dirFn }),
        });
        const d = await res.json();
        const t = d.thread as Thread | null;
        if (t) {
          setThreadId(t.id);
          setMessages(t.messages);
          setActions(t.pending_actions || []);
          if (t.source) setSource(t.source);
        } else {
          setError(d.error || "Could not start the turn.");
          setThinking(false);
        }
      } catch {
        setError("Network error.");
        setThinking(false);
      }
    },
    [input, thinking, threadId, dirFn],
  );

  const decide = useCallback(
    async (actionId: string, decision: "approve" | "decline") => {
      if (!threadId) return;
      setError(null);
      if (decision === "approve") setThinking(true);
      try {
        const res = await fetch("/api/director/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: threadId, actionId, decision, action: "approve" }),
        });
        const d = await res.json();
        const t = d.thread as Thread | null;
        if (t) {
          setActions(t.pending_actions || []);
          setMessages(t.messages);
        }
      } catch {
        setError("Network error.");
        setThinking(false);
      }
    },
    [threadId],
  );

  const startNew = () => {
    setThreadId(null);
    setMessages([]);
    setActions([]);
    setError(null);
    setInput("");
    setSource("web");
  };

  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      {messages.length > 0 && (
        <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
          <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-400">
            Conversation
            {source === "slack" && (
              <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[9px] font-medium normal-case text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" title="This conversation is happening in your #cto-ada Slack channel — it stays in sync both ways.">
                via Slack 💬
              </span>
            )}
          </span>
          <button onClick={startNew} disabled={thinking} className="text-[11px] text-zinc-500 hover:text-zinc-800 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200">
            + New thread
          </button>
        </div>
      )}
      <div ref={scrollRef} className="max-h-96 space-y-3 overflow-y-auto p-3">
        {!messages.length && (
          <p className="px-1 py-6 text-center text-[12px] text-zinc-400">
            Ask {name} why something has or hasn&apos;t happened — &ldquo;why haven&apos;t you built spec X?&rdquo; {name} explains from real state. Hand over a plan with <span className="font-medium">Give a plan</span>, or turn what you write into a durable rule with <span className="font-medium">Coach</span> (you confirm either).
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] ${m.role === "user" ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"}`}>
              {m.content}
            </div>
          </div>
        ))}

        {/* Coaching / spec approval cards. */}
        {actions.map((a) => (
          <div key={a.id} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] dark:border-amber-800 dark:bg-amber-950/30">
            <div className="flex items-center gap-2">
              <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-800 dark:text-amber-100">
                {a.type === "coaching" ? "new coaching rule" : a.type === "goal" ? "new goal · for your greenlight" : a.type === "spec-edit" ? "spec edit" : a.type === "directive" ? "new directive · trumps routine" : "spec handoff"}
              </span>
              <span className="font-medium text-zinc-800 dark:text-zinc-100">{a.summary}</span>
            </div>
            {a.type === "directive" && (
              <div className="mt-1.5 text-zinc-700 dark:text-zinc-300">
                {a.steps && a.steps.length > 0 && (
                  <ol className="ml-4 list-decimal space-y-0.5">
                    {a.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
                {a.gateBuildsUntil && <p className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">⏸ gates routine builds until <span className="font-mono">{a.gateBuildsUntil}</span> ships (priority builds still run)</p>}
                {a.criticalSpecs && a.criticalSpecs.length > 0 && <p className="mt-0.5 text-[11px] text-zinc-500">queues + marks critical: {a.criticalSpecs.join(", ")}</p>}
                {a.holdBuilds && a.holdBuilds.length > 0 && <p className="mt-0.5 text-[11px] text-rose-600 dark:text-rose-400">cancels (out-of-order): {a.holdBuilds.join(", ")}</p>}
              </div>
            )}
            {a.type === "coaching" && a.guidance && <p className="mt-1.5 text-zinc-700 dark:text-zinc-300">“{a.guidance}”{a.reasoning ? ` — ${a.reasoning}` : ""}</p>}
            {a.type === "spec" && a.slug && <p className="mt-1.5 font-mono text-[11px] text-zinc-500">specs/{a.slug}.md</p>}
            {a.type === "spec-edit" && a.slug && <p className="mt-1.5 font-mono text-[11px] text-zinc-500">✎ specs/{a.slug}.md · edit existing</p>}
            {a.type === "goal" && (
              <p className="mt-1.5 text-zinc-700 dark:text-zinc-300">
                {a.outcome ? `“${a.outcome}” ` : ""}
                <span className="font-mono text-[11px] text-zinc-500">goals/{a.slug}.md · approve to surface for your greenlight</span>
              </p>
            )}
            {a.status === "pending" ? (
              <div className="mt-2 flex gap-2">
                <button onClick={() => decide(a.id, "approve")} className="rounded bg-green-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-green-700">
                  {a.type === "coaching" ? "Apply rule" : a.type === "goal" ? "Approve & propose" : a.type === "directive" ? "Approve & activate" : "Approve"}
                </button>
                <button onClick={() => decide(a.id, "decline")} className="rounded border border-zinc-300 px-2.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                  Dismiss
                </button>
              </div>
            ) : (
              <p className={`mt-2 text-[11px] font-medium ${a.status === "done" ? "text-green-600 dark:text-green-400" : a.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
                {a.status === "done" ? "✓ applied" : a.status}{a.result ? ` — ${a.result}` : ""}
              </p>
            )}
          </div>
        ))}

        {thinking && <p className="px-1 text-[12px] text-zinc-400">{name} is thinking… (a box turn runs on Max — up to a couple of minutes)</p>}
        {error && <p className="px-1 text-[12px] text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send("ask");
            }
          }}
          placeholder={`Ask ${name} anything about what they're doing…`}
          rows={2}
          className="w-full resize-none rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <span className="mr-auto text-[10px] text-zinc-400">⌘↵ to ask</span>
          <button
            onClick={() => void send("ask")}
            disabled={thinking || !input.trim()}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Ask
          </button>
          <button
            onClick={() => void send("plan")}
            disabled={thinking || !input.trim()}
            title="Hand her a plan to execute — it becomes her active directive and trumps her routine until done (you'll confirm it)"
            className="rounded-md border border-violet-300 px-3 py-1.5 text-[12px] font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-40 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/30"
          >
            Give a plan
          </button>
          <button
            onClick={() => void send("coach")}
            disabled={thinking || !input.trim()}
            title={`Turn what you just wrote into a durable rule ${name} follows going forward (you'll confirm it)`}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
          >
            Coach
          </button>
        </div>
      </div>
    </div>
  );
}
