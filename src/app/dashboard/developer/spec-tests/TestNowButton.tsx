"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Test now" — enqueues a box spec-test job for one spec (spec-test-agent).
 * POST /api/roadmap/spec-test; the box claims it on its concurrency-1 lane and writes a spec_test_runs
 * row. Owner-only (the API enforces it). The run appears here after the box finishes + a refresh.
 *
 * Two modes:
 *  - post-ship (default): no `branch` prop → API enqueues a standing-lane `kind='spec-test'` job that hits
 *    prod (the original behavior — shipped-unverified specs). Deduped by [[hasActiveSpecTestJob]].
 *  - pre-merge (branch prop; premerge-spectest-rerun-and-visibility Phase 3): API looks up the branch's
 *    latest build, fresh-captures its Vercel preview, then force-enqueues via
 *    [[enqueuePreMergeSpecTest]] so a stale terminal verdict (approved/needs_human/issues) does NOT
 *    block the manual re-run. Only an in-flight spec-test on the same branch or a non-READY preview
 *    refuses the re-run. The re-run affordance for the "Pre-merge" surface on the Developer → Spec
 *    Tests page. The server owns the preview capture — the button never passes a preview URL.
 */
export default function TestNowButton({
  slug,
  compact = false,
  branch,
}: {
  slug: string;
  compact?: boolean;
  branch?: string | null;
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
