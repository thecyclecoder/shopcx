"use client";

/**
 * /dashboard/developer/spec-tests/human-queue — the Human-test queue (spec-test-agent Phase 2).
 *
 * ADVISORY / OPTIONAL (fold-on-spec-test-pass, task #29): folding into the brain now fires on the MACHINE
 * spec-test pass, NOT on clearing this queue. This list is the parts the box QA agent classified `needs_human`
 * (visual/UX or prod-mutating) across the latest run of every shipped-but-unverified spec — a place to run
 * extra human QA if you want, NOT a gate. It never blocks the fold, the brain, or a spec's progression; you
 * can clear an item whenever (or never). Regressions (a shipped spec that FAILED its own spec-test — those DO
 * block the fold) live on their own page at /dashboard/developer/regressions.
 * Read-only over /api/developer/spec-test/human-queue; the owner's resolutions are the only writes.
 * Polls every ~8s + revalidates on focus.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Evidence, relativeTime, type Resolution, type QueueItem, type QueueData } from "../shared";

const RESOLUTION_LABEL: Record<Resolution, string> = {
  verified: "✓ Tested — works",
  failed: "✗ Tested — broken",
  dismissed: "Dismissed — N/A",
};

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
    // cut-internal-egress-pooler-and-spec-rpcs Phase 3: visibility-guard the 8s tick — a
    // backgrounded tab stops firing this poll and refreshes on return-to-visible. Mirrors the
    // shipped sidebar reduce-calls pattern (src/app/dashboard/sidebar.tsx:347); the existing
    // focus listener already refreshed on tab return, this narrows the tick.
    load();
    const runPoll = () => { if (document.visibilityState === "visible") load(true); };
    const interval = setInterval(runPoll, 8000);
    const onFocus = () => load(true);
    const onVisibility = () => { if (document.visibilityState === "visible") load(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const resolve = useCallback(
    async (item: { slug: string; check_key: string; text: string }, resolution: Resolution | "clear") => {
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
  const waiting = items.filter((i) => i.resolution === null);
  const done = items.filter((i) => i.resolution !== null);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pt-20 md:pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Human-test queue</h1>
            <span className="rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
              Advisory · optional
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            The parts the box QA agent <span className="font-medium">can&apos;t</span> auto-test (visual/UX or
            prod-mutating) across every shipped-but-unverified spec. Optional extra QA — specs already fold into
            the brain on the machine spec-test pass, so this never blocks anything. Clear an item whenever you
            want, or never.
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
          {/* Needs human testing — the waiting pile. */}
          <section className="space-y-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">👤 Human QA pending</h2>
              <span className="text-xs tabular-nums text-zinc-400">{waiting.length}</span>
              <span className="text-xs text-zinc-400">· optional — never blocks the fold</span>
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
