"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

/**
 * Owner-only toggle for a spec's `**Priority:** critical` marker. Optimistic: flips the pip
 * instantly, POSTs to /api/roadmap/priority (which commits/removes the line-anchored marker in
 * the brain on main), reverts on error. Renders nothing for non-owners.
 *
 * The derived `SpecCard.critical` (brain-roadmap.ts) reads the same marker, so once the commit
 * redeploys the board pip matches; the optimistic flip keeps the control responsive meanwhile.
 */
export default function CriticalToggle({ slug, critical }: { slug: string; critical: boolean }) {
  const workspace = useWorkspace();
  const [current, setCurrent] = useState(critical);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  if (workspace.role !== "owner") return null;

  async function toggle() {
    if (saving) return;
    const next = !current;
    setCurrent(next);
    setSaving(true);
    setError(false);
    try {
      const res = await fetch("/api/roadmap/priority", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, critical: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setCurrent(!next);
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={saving}
        onClick={toggle}
        aria-pressed={current}
        className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-60 ${
          current
            ? "border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
            : "border-zinc-200 text-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        }`}
        title={current ? "Critical — tap to clear **Priority:** critical" : "Tap to mark **Priority:** critical (queues first / can gate)"}
      >
        {current ? "🔴 Critical" : "Mark critical"}
      </button>
      {saving && <span className="text-[10px] text-zinc-400">saving…</span>}
      {error && <span className="text-[10px] text-rose-500">failed</span>}
    </div>
  );
}
