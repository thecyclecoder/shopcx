"use client";

import { useState } from "react";
import type { SpecStatus } from "@/lib/brain-roadmap";

// Owner-only unified control for a spec's PRIORITY (director-executable-plans-and-priority): Prioritize
// (**Priority:** critical — queues first / can gate), Defer (**Deferred:** — parked, excluded from every
// auto-build lane), or Planned (clears both → a normal spec). Mutually exclusive. Optimistic; POSTs the
// `state` to /api/roadmap/priority, which commits the line-anchored marker to the brain on main.

type Priority = "planned" | "deferred" | "critical";

function currentPriority(status: SpecStatus, critical?: boolean): Priority {
  if (status === "deferred") return "deferred";
  if (critical) return "critical";
  return "planned";
}

const SEGMENTS: { key: Priority; label: string; active: string }[] = [
  { key: "critical", label: "Prioritize", active: "bg-rose-600 text-white" },
  { key: "planned", label: "Planned", active: "bg-zinc-700 text-white dark:bg-zinc-200 dark:text-zinc-900" },
  { key: "deferred", label: "Defer", active: "bg-amber-500 text-white" },
];

export default function PriorityControl({ slug, status, critical }: { slug: string; status: SpecStatus; critical?: boolean }) {
  const [current, setCurrent] = useState<Priority>(currentPriority(status, critical));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  async function set(next: Priority) {
    if (next === current || busy) return;
    const prev = current;
    setCurrent(next); // optimistic
    setBusy(true);
    setErr(false);
    try {
      const res = await fetch("/api/roadmap/priority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, state: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setCurrent(prev); // revert
      setErr(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1" title="Set this spec's build priority">
      <span className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            onClick={() => void set(s.key)}
            disabled={busy}
            className={`px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
              current === s.key ? s.active : "bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {s.label}
          </button>
        ))}
      </span>
      {err && <span className="text-[10px] text-rose-500">failed</span>}
    </span>
  );
}
