"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Compact build-box chip on the roadmap board header (build-box-status-view Phase 3):
// "Build box · 3/5 lanes · healthy" → links to the full box view. Goes stale/red if the
// heartbeat is old. Polls /api/roadmap/box every ~10s (lighter than the box page's 5s).

const STALE_MS = 30_000;

interface LaneRow { kind: string }
interface Worker {
  last_poll_at: string | null;
  build_lanes: number;
  lanes: LaneRow[];
}

export default function BoxChip() {
  const [worker, setWorker] = useState<Worker | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/roadmap/box")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setWorker(d.worker ?? null);
        })
        .catch(() => {})
        .finally(() => alive && setLoaded(true));
    load();
    const interval = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  if (!loaded || !worker) return null;

  const stale = !worker.last_poll_at || Date.now() - new Date(worker.last_poll_at).getTime() > STALE_MS;
  const buildInUse = (worker.lanes ?? []).filter((l) => l.kind !== "fold").length;
  const cls = stale
    ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300"
    : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300";

  return (
    <Link
      href="/dashboard/roadmap/box"
      title="Build box status"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${cls}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-rose-500" : "bg-emerald-500"}`} />
      Build box · {buildInUse}/{worker.build_lanes} lanes · {stale ? "stale" : "healthy"}
    </Link>
  );
}
