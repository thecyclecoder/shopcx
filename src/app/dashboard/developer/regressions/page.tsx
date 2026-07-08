"use client";

/**
 * /dashboard/developer/regressions — Regressions (spec-test-agent Phase 2).
 *
 * High-signal surface for shipped specs that FAILED their own spec-test. The box QA agent re-runs the
 * non-destructive `## Verification` bullets across every shipped-but-unverified spec; a spec whose
 * already-passing checks regress lands here with a one-click "Propose fix spec" route into box-spec-chat.
 * Separated from the Human-test queue (which is the needs-human pile) so a real regression never hides
 * behind the routine testing backlog. Read-only over /api/developer/spec-test/human-queue; the owner's
 * dismissals are the only writes. Owner-only. Polls every ~8s + revalidates on focus.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import ProposeFixButton from "../spec-tests/ProposeFixButton";
import { Evidence, relativeTime, type QueueData, type Regression } from "../spec-tests/shared";

export default function RegressionsPage() {
  const workspace = useWorkspace();
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
        setError(d.error || "Failed to load regressions");
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
    if (workspace.role !== "owner") return;
    // cut-internal-egress-pooler-and-spec-rpcs Phase 3: visibility-guard the 8s tick — a
    // backgrounded tab stops the fan-out and refreshes on return-to-visible. Widened from
    // the shipped sidebar reduce-calls pattern (src/app/dashboard/sidebar.tsx:347) — the
    // existing focus listener already refreshed on tab return, this narrows the tick.
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
  }, [load, workspace.role]);

  const dismiss = useCallback(
    async (item: { slug: string; check_key: string; text: string }) => {
      const id = `${item.slug}:${item.check_key}`;
      setBusy((prev) => new Set(prev).add(id));
      try {
        await fetch("/api/developer/spec-test/human-queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: item.slug,
            check_key: item.check_key,
            check_text: item.text,
            resolution: "dismissed",
          }),
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

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Regressions</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const regressions: Regression[] = data?.regressions ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pt-20 md:pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-rose-700 dark:text-rose-400">⚠️ Regressions</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Shipped specs failing their own spec-test. Each one was verified once and has since broken — fix it
            or dismiss false positives.
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
      ) : regressions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No regressions — every shipped spec still passes its own spec-test.
        </p>
      ) : (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-400">Failing</h2>
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
                    <ProposeFixButton slug={r.slug} compact mode="chat" />
                  </div>
                </div>
                {r.failing.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {r.failing.map((f, i) => (
                      <li key={i} className="text-xs">
                        <div className="flex items-start gap-1.5">
                          <span className="mt-0.5 flex-shrink-0 font-medium text-rose-600 dark:text-rose-400">✗</span>
                          <div className="min-w-0 flex-1">
                            <span className="text-zinc-700 dark:text-zinc-300">{f.text}</span>
                            {f.evidence && <Evidence text={f.evidence} />}
                          </div>
                          <button
                            type="button"
                            disabled={busy.has(`${r.slug}:${f.check_key}`)}
                            onClick={() => dismiss({ slug: r.slug, check_key: f.check_key, text: f.text })}
                            className="shrink-0 rounded border border-rose-200 px-2 py-0.5 text-[11px] font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-900/30"
                            title="Not a real regression (false positive / acknowledged) — clears it from this list"
                          >
                            {busy.has(`${r.slug}:${f.check_key}`) ? "…" : "Dismiss"}
                          </button>
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
    </div>
  );
}
