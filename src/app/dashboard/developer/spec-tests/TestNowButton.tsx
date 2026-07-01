"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Test now" — enqueues a box spec-test job for one spec (spec-test-agent).
 * POST /api/roadmap/spec-test; the box claims it on its concurrency-1 lane and writes a spec_test_runs
 * row. Owner-only (the API enforces it). The run appears here after the box finishes + a refresh.
 *
 * Two modes (spectest-error-visible-and-rerunnable Phase 2):
 *  - post-ship (default): no `branch` prop → API enqueues a standing-lane `kind='spec-test'` job that hits
 *    prod (the original behavior — shipped-unverified specs). Deduped by [[hasActiveSpecTestJob]].
 *  - pre-merge (branch + previewUrl props): API delegates to [[enqueuePreMergeSpecTest]], stamping
 *    `spec_branch` + `preview_url` so the runner probes the per-build `*.vercel.app` preview instead of
 *    prod. Dedupe is per-branch (a real approved/needs_human/issues verdict blocks; an `error` verdict
 *    falls through so a reaped session can re-run). The re-run affordance for the "Pre-merge / errored"
 *    surface on the Developer → Spec Tests page.
 */
export default function TestNowButton({
  slug,
  compact = false,
  branch,
  previewUrl,
}: {
  slug: string;
  compact?: boolean;
  branch?: string | null;
  previewUrl?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/spec-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          ...(branch ? { branch } : {}),
          ...(previewUrl ? { previewUrl } : {}),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "failed to queue");
      if (d.queued === false) {
        setError(typeof d.reason === "string" ? d.reason : "not enqueued");
        return;
      }
      setDone(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to queue");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={run}
        disabled={busy || done}
        className={`rounded-md font-medium text-white disabled:opacity-50 ${
          compact ? "bg-indigo-600 px-2 py-0.5 text-[11px] hover:bg-indigo-700" : "bg-indigo-600 px-2.5 py-1 text-xs hover:bg-indigo-700"
        }`}
        title="Queue the box QA agent to run this spec's non-destructive verification checks"
      >
        {busy ? "Queuing…" : done ? "Queued ✓" : "Test now"}
      </button>
      {error && <span className="text-[11px] text-rose-500">{error}</span>}
    </span>
  );
}
