"use client";

/**
 * RunningTimer — the top-of-timeline live-ticking client island driving the "Elapsed: <duration>"
 * badge on an in-progress spec ([[spec-detail-timecard-timeline]] Phase 3). Reuses the
 * {@link WaitTimer} pattern (useEffect + 1-second setInterval) so both islands hydrate the same
 * way — and both are the ONLY client components on the timeline. When the spec is folded /
 * terminal, [slug]/page.tsx renders a plain server-rendered "Total: <static duration>" label
 * instead of mounting this island (no client re-render on a terminal spec).
 */
import { useEffect, useState } from "react";
import { formatDurationCompact } from "./LifecycleTimeline";

interface RunningTimerProps {
  /** ISO timestamp anchoring the elapsed count — the timecard's `first_event_at`. */
  since: string;
  /** Prefix label the badge renders in front of the duration (default `Elapsed:`). */
  label?: string;
}

export default function RunningTimer({ since, label = "Elapsed:" }: RunningTimerProps) {
  const start = Date.parse(since);
  const [now, setNow] = useState<number>(() => (Number.isFinite(start) ? Math.max(start, Date.now()) : Date.now()));
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [start]);
  if (!Number.isFinite(start)) return null;
  return (
    <span className="text-zinc-500 dark:text-zinc-400">
      {label} <span className="font-medium text-zinc-700 dark:text-zinc-200">{formatDurationCompact(now - start)}</span>
    </span>
  );
}
