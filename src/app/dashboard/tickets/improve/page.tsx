"use client";

/**
 * /dashboard/tickets/improve — the Improve Queue (improve-queue spec).
 *
 * Surfaces every active ticket Improve session for the workspace so you can fire off several box
 * Improve turns, walk away, and glance at which ones the box has answered — then deep-link straight
 * to the ticket's Improve tab. Read-only over /api/tickets/improve-queue; it surfaces + links, it
 * never acts (you Approve/reply on the ticket's Improve tab). Polls every ~8s + revalidates on focus.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type QueueState = "answered" | "needs_approval" | "error" | "thinking" | "idle";

interface QueueItem {
  ticket_id: string;
  subject: string | null;
  customer_name: string | null;
  turn_status: string;
  queue_state: QueueState;
  last_error: string | null;
  updated_at: string;
}

const CHIP: Record<QueueState, { label: string; className: string }> = {
  answered: { label: "Answered — go read", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  needs_approval: { label: "Needs approval", className: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  error: { label: "Error — retry", className: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" },
  thinking: { label: "Thinking…", className: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  idle: { label: "Idle", className: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function Row({ item }: { item: QueueItem }) {
  const chip = CHIP[item.queue_state];
  return (
    <Link
      href={`/dashboard/tickets/${item.ticket_id}`}
      className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {item.subject || "(no subject)"}
        </p>
        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
          {item.customer_name || "Unknown customer"}
          {item.queue_state === "error" && item.last_error ? ` · ${item.last_error}` : ""}
        </p>
      </div>
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${chip.className}`}>
        {chip.label}
      </span>
      <span className="hidden shrink-0 text-xs tabular-nums text-zinc-400 sm:inline">
        {relativeTime(item.updated_at)}
      </span>
      <span className="shrink-0 text-zinc-300 dark:text-zinc-600">&#9656;</span>
    </Link>
  );
}

function Group({ title, hint, items }: { title: string; hint: string; items: QueueItem[] }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        <span className="text-xs tabular-nums text-zinc-400">{items.length}</span>
        <span className="text-xs text-zinc-400">· {hint}</span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-400 dark:border-zinc-800">
          Nothing here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <Row key={item.ticket_id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

const WAITING_ORDER: QueueState[] = ["answered", "needs_approval", "error"];

export default function ImproveQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/tickets/improve-queue");
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to load queue");
        return;
      }
      setError(null);
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      // transient — keep the last good state, the next poll retries
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => load(true), 8000);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const waiting = items
    .filter((i) => WAITING_ORDER.includes(i.queue_state))
    .sort((a, b) => WAITING_ORDER.indexOf(a.queue_state) - WAITING_ORDER.indexOf(b.queue_state));
  const inProgress = items.filter((i) => i.queue_state === "thinking");

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pt-20 md:pt-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Improve Queue</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Box Improve turns across your tickets. Answered / Needs approval are waiting on you — click through to act.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : (
        <div className="space-y-6">
          <Group title="Waiting on you" hint="Answered · Needs approval · Error" items={waiting} />
          <Group title="In progress" hint="Thinking…" items={inProgress} />
        </div>
      )}
    </div>
  );
}
