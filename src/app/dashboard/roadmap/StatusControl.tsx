"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { Phase } from "@/lib/brain-roadmap";

const OPTS: { key: Phase; label: string; active: string }[] = [
  { key: "planned", label: "Planned", active: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100" },
  { key: "in_progress", label: "Doing", active: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  { key: "shipped", label: "Shipped", active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
];

/**
 * Owner-only segmented control to flip a spec's status. Optimistic: updates instantly,
 * POSTs to /api/roadmap/status (which commits the emoji to the brain on main), reverts on error.
 * Renders nothing for non-owners.
 */
export default function StatusControl({ slug, status }: { slug: string; status: Phase }) {
  const workspace = useWorkspace();
  const [current, setCurrent] = useState<Phase>(status);
  const [saving, setSaving] = useState<Phase | null>(null);
  const [error, setError] = useState(false);

  if (workspace.role !== "owner") return null;

  async function set(next: Phase) {
    if (next === current || saving) return;
    const prev = current;
    setCurrent(next);
    setSaving(next);
    setError(false);
    try {
      const res = await fetch("/api/roadmap/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, status: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setCurrent(prev);
      setError(true);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="inline-flex items-center gap-1">
      <div className="inline-flex overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700">
        {OPTS.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={saving !== null}
            onClick={() => set(o.key)}
            className={`px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-60 ${
              current === o.key ? o.active : "text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
            title={`Set status: ${o.label}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {saving && <span className="text-[10px] text-zinc-400">saving…</span>}
      {error && <span className="text-[10px] text-rose-500">failed</span>}
    </div>
  );
}
