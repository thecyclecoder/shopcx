"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { Phase, SpecStatus } from "@/lib/brain-roadmap";

// spec-review-agent Phase 4 — `in_review` is a CEO BOARD CONTROL: send a spec back for re-disposition when
// it's malformed/off, regardless of where it currently sits. The route clears vale_pass / ada_disposition /
// intended_status so the next Vale + Ada pass start clean. Phases never carry `in_review` — it's a
// card-level target only.
type StatusKey = Phase | "in_review";

const OPTS: { key: StatusKey; label: string; active: string; title?: string }[] = [
  { key: "in_review", label: "In Review", active: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100", title: "Send back to In Review — Vale re-checks the CHECKLIST before this can build again" },
  { key: "planned", label: "Planned", active: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100" },
  { key: "in_progress", label: "Doing", active: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" },
  { key: "shipped", label: "Shipped", active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" },
];

/**
 * Owner-only segmented control to flip a spec's status. Optimistic: updates instantly,
 * POSTs to /api/roadmap/status (which writes the DB mirror + spec_status_history), reverts on error.
 * Renders nothing for non-owners.
 *
 * spec-review-agent Phase 4: the **In Review** segment is the CEO board control for sending a
 * malformed/off spec back for re-disposition (the route fast-paths through markSpecCardBackToReview,
 * which consumes the prior Vale-pass / Ada-disposition signals so the re-review starts clean).
 */
// `status` may be `deferred` (the Deferred column) — no segment is then active; flipping to a phase status
// posts normally. Un-deferring (removing the marker) stays a markdown/CEO action, not this control.
export default function StatusControl({ slug, status }: { slug: string; status: SpecStatus }) {
  const workspace = useWorkspace();
  const [current, setCurrent] = useState<SpecStatus>(status);
  const [saving, setSaving] = useState<StatusKey | null>(null);
  const [error, setError] = useState(false);

  if (workspace.role !== "owner") return null;

  async function set(next: StatusKey) {
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
            title={o.title ?? `Set status: ${o.label}`}
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
