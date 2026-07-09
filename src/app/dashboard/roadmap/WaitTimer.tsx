"use client";

/**
 * WaitTimer — the tiny live-ticking client island the M5 WaitRow embeds so a spec parked at
 * needs_approval / blocked_on_dependency / blocked_on_usage shows a duration that increments
 * once per second in the browser without a page refresh ([[spec-detail-timecard-timeline]]
 * Phase 2). Every other subcomponent on the detail-page timeline stays server-rendered —
 * this island is deliberately atomic so the JS bundle stays minimal (Phase 3's client-hydration
 * verification).
 *
 * Not for the running-total badge — that reuses this pattern via {@link ../RunningTimer}.
 * Both share {@link formatDurationCompact} so the ticker's shape (42s / 3m 12s / 2h 4m)
 * stays identical to the server-rendered per-stage duration labels above it.
 */
import { useEffect, useState } from "react";
import { formatDurationCompact } from "./LifecycleTimeline";

interface WaitTimerProps {
  /** ISO timestamp anchoring the elapsed count — the wait's `entered_at` from the M1 SDK. */
  since: string;
}

export default function WaitTimer({ since }: WaitTimerProps) {
  const start = Date.parse(since);
  const [now, setNow] = useState<number>(() => (Number.isFinite(start) ? Math.max(start, Date.now()) : Date.now()));
  useEffect(() => {
    if (!Number.isFinite(start)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [start]);
  if (!Number.isFinite(start)) return null;
  return <>{formatDurationCompact(now - start)}</>;
}
