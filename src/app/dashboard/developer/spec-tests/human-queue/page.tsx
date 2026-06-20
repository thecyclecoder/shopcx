"use client";

/**
 * /dashboard/developer/spec-tests/human-queue — the Human-test queue (spec-test-agent Phase 2).
 *
 * The box spec-test QA agent runs the non-destructive `## Verification` bullets and classifies the rest
 * (visual/UX or prod-mutating) as `needs_human`. This page aggregates every `needs_human` check across
 * the latest run of every shipped-but-unverified spec — the parts only the owner can do — so they do
 * only those, mark each tested, and clear the queue before the Verified & archive gate. Regressions
 * (a shipped spec that FAILED its own spec-test) surface loudly at the top with a one-click
 * "Propose fix spec" route into box-spec-chat. Read-only over /api/developer/spec-test/human-queue;
 * the owner's resolutions are the only writes. Polls every ~8s + revalidates on focus.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ProposeFixButton from "../ProposeFixButton";

type Resolution = "verified" | "failed" | "dismissed";

interface QueueItem {
  slug: string;
  title: string;
  text: string;
  evidence?: string;
  check_key: string;
  run_at: string;
  resolution: Resolution | null;
  resolved_at: string | null;
  note: string | null;
}
interface Regression {
  slug: string;
  title: string;
  run_at: string;
  agent_verdict: string;
  failing: { text: string; evidence?: string }[];
}
interface QueueData {
  items: QueueItem[];
  regressions: Regression[];
  counts: { waiting: number; resolved: number; regressions: number };
}

const RESOLUTION_LABEL: Record<Resolution, string> = {
  verified: "✓ Tested — works",
  failed: "✗ Tested — broken",
  dismissed: "Dismissed — N/A",
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Evidence({ text }: { text: string }) {
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer select-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
        evidence
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-zinc-50 p-1.5 text-[11px] text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
        {text}
      </pre>
    </details>
  );
}

export default function HumanTestQueuePage() {
  const [data, setData] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch("/api/developer/spec-test/human-queue");
      const d = await res.json();
      if (!res.ok) {
        setError(d.error || "Failed to load queue");
        return;
      }
      setError(null);
      setData(d as QueueData);
    } catch {
      // transient — keep last good state, the next poll retries
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

  const resolve = useCallback(
    async (item: QueueItem, resolution: Resolution | "clear") => {
      const id = `${item.slug}:${item.check_key}`;
      setBusy((prev) => new Set(prev).add(id));
      try {
        await fetch("/api/developer/spec-test/human-queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            resolution === "clear"
              ? { slug: item.slug, check_key: item.check_key, clear: true }
              : { slug: item.slug, check_key: item.check_key, check_text: item.text, resolution },
          ),
        });
      } catch {
        // transient — the next poll reconciles
      }
      await load(true);
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [load],
  );

  const items = data?.items ?? [];
  const regressions = data?.regressions ?? [];
  const waiting = items.filter((i) => i.resolution === null);
  const done = items.filter((i) => i.resolution !== null);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pt-20 md:pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Human-test queue</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            The parts the box QA agent <span className="font-medium">can&apos;t</span> auto-test (visual/UX or
            prod-mutating) across every shipped-but-unverified spec. Do them, mark each tested, then verify.
          </p>
        </div>
        <Link
          href="/dashboard/developer/spec-tests"
          className="shrink-0 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Spec Tests →
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-400">
          {error}
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : (
        <div className="space-y-6">
          {/* Regressions — high-signal: a shipped spec failing its own verification. Surface loudly. */}
          {regressions.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-400">⚠️ Regressions</h2>
                <span className="text-xs tabular-nums text-rose-400">{regressions.length}</span>
                <span className="text-xs text-zinc-400">· shipped but failing its own spec-test</span>
              </div>
              <div className="space-y-2">
                {regressions.map((r) => (
                  <div
                    key={r.slug}
                    className="rounded-lg border border-rose-200 bg-rose-50/60 px-4 py-3 dark:border-rose-900/50 dark:bg-rose-950/20"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/dashboard/roadmap/${r.slug}`}
                        className="text-sm font-medium text-rose-800 hover:underline dark:text-rose-300"
                      >
                        {r.title}
                      </Link>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] tabular-nums text-zinc-400">{relativeTime(r.run_at)}</span>
                        <ProposeFixButton slug={r.slug} compact />
                      </div>
                    </div>
                    {r.failing.length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {r.failing.map((f, i) => (
                          <li key={i} className="text-xs">
                            <div className="flex items-start gap-1.5">
                              <span className="mt-0.5 flex-shrink-0 font-medium text-rose-600 dark:text-rose-400">✗</span>
                              <div className="min-w-0">
                                <span className="text-zinc-700 dark:text-zinc-300">{f.text}</span>
                                {f.evidence && <Evidence text={f.evidence} />}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Needs human testing — the waiting pile. */}
          <section className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">👤 Needs human testing</h2>
              <span className="text-xs tabular-nums text-zinc-400">{waiting.length}</span>
              <span className="text-xs text-zinc-400">· only you can run these</span>
            </div>
            {waiting.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-400 dark:border-zinc-800">
                Nothing waiting — every human check across your shipped specs is resolved.
              </p>
            ) : (
              <div className="space-y-1.5">
                {waiting.map((item) => {
                  const id = `${item.slug}:${item.check_key}`;
                  const isBusy = busy.has(id);
                  return (
                    <div
                      key={id}
                      className="rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 dark:border-amber-900/40 dark:bg-amber-950/15"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/dashboard/roadmap/${item.slug}`}
                            className="text-xs font-medium text-amber-700 hover:underline dark:text-amber-400"
                          >
                            {item.title}
                          </Link>
                          <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-300">{item.text}</p>
                          {item.evidence && <Evidence text={item.evidence} />}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => resolve(item, "verified")}
                            className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                          >
                            ✓ Tested
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => resolve(item, "dismissed")}
                            className="rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Done — resolved checks, collapsed; re-open to send one back to waiting. */}
          {done.length > 0 && <DoneGroup items={done} onClear={(item) => resolve(item, "clear")} busy={busy} />}
        </div>
      )}
    </div>
  );
}

function DoneGroup({
  items,
  onClear,
  busy,
}: {
  items: QueueItem[];
  onClear: (item: QueueItem) => void;
  busy: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-baseline gap-2 text-left">
        <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Done</h2>
        <span className="text-xs tabular-nums text-zinc-400">{items.length}</span>
        <span className="text-xs text-zinc-400">· resolved by you</span>
      </button>
      {open && (
        <div className="space-y-1.5">
          {items.map((item) => {
            const id = `${item.slug}:${item.check_key}`;
            return (
              <div
                key={id}
                className="flex items-start justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 px-4 py-2.5 dark:border-zinc-800/70 dark:bg-zinc-900/40"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{item.title}</span>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{item.text}</p>
                  <span className="text-[11px] text-zinc-400">
                    {item.resolution ? RESOLUTION_LABEL[item.resolution] : ""}
                    {item.resolved_at ? ` · ${relativeTime(item.resolved_at)}` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={busy.has(id)}
                  onClick={() => onClear(item)}
                  className="shrink-0 rounded-md border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Re-open
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
