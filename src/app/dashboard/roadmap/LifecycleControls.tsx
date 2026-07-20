"use client";

import { useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import type { SpecStatus } from "@/lib/brain-roadmap";

/**
 * Owner/CEO-only EXPLICIT-LIFECYCLE controls for a spec card. These are the REAL inputs on the
 * roadmap board — the planned/in_progress/shipped status is DERIVED from `spec_phases` by getRoadmap
 * and is NEVER user-settable here (the old manual status segmented control was retired with the
 * spec_card_state overlay). What remains are the genuine lifecycle levers:
 *
 *   - Review     → POST /api/roadmap/status  { status: "in_review" }   — clears the disposition flags so Ada re-disposes.
 *   - Prioritize → POST /api/roadmap/priority { state: "critical" }     — sets specs.priority = 'critical'.
 *   - Make Active→ POST /api/roadmap/priority { state: "planned" }      — clears specs.deferred (un-defer);
 *                                                                          rendered only when the card IS deferred.
 *   - Defer      → POST /api/roadmap/priority { state: "deferred" }     — sets specs.deferred = true;
 *                                                                          rendered only when the card is NOT deferred.
 *
 * Both routes are owner-gated server-side and project onto the canonical `public.specs` columns
 * (status / priority / deferred) — no raw SQL, no spec_card_state read on the board. Optimistic with
 * a per-button busy state; a failed POST surfaces a "failed" hint (the next render reconciles from the DB).
 */
export default function LifecycleControls({ slug, status, critical }: { slug: string; status: SpecStatus; critical?: boolean }) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  // Optimistic local mirrors so a click reflects immediately (server render reconciles next load).
  const [deferred, setDeferred] = useState(status === "deferred");
  const [isCritical, setIsCritical] = useState(!!critical);

  if (workspace.role !== "owner") return null;

  async function post(url: string, body: Record<string, unknown>, key: string, onOk: () => void) {
    if (busy) return;
    setBusy(key);
    setErr(false);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      onOk();
    } catch {
      setErr(true);
    } finally {
      setBusy(null);
    }
  }

  const review = () => post("/api/roadmap/status", { slug, status: "in_review" }, "review", () => {});
  const prioritize = () => post("/api/roadmap/priority", { slug, state: "critical" }, "prioritize", () => setIsCritical(true));
  const makeActive = () => post("/api/roadmap/priority", { slug, state: "planned" }, "active", () => setDeferred(false));
  const defer = () => post("/api/roadmap/priority", { slug, state: "deferred" }, "defer", () => setDeferred(true));

  const btn =
    "rounded-md border border-zinc-200 px-2 py-1 text-[10px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <div className="inline-flex flex-wrap items-center gap-1">
      <button type="button" onClick={review} disabled={busy !== null} className={btn} title="Send back to the In Review queue — Vale re-checks the spec before it can build again">
        {busy === "review" ? "…" : "Review"}
      </button>
      <button
        type="button"
        onClick={prioritize}
        disabled={busy !== null || isCritical}
        className={`${btn} ${isCritical ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300" : ""}`}
        title="Set Priority: critical — queued first, can gate the build queue"
      >
        {busy === "prioritize" ? "…" : isCritical ? "Critical" : "Prioritize"}
      </button>
      {deferred ? (
        <button type="button" onClick={makeActive} disabled={busy !== null} className={btn} title="Un-defer — make this spec active (eligible for the build lanes again)">
          {busy === "active" ? "…" : "Make Active"}
        </button>
      ) : (
        <button type="button" onClick={defer} disabled={busy !== null} className={btn} title="Defer — park this spec; excluded from every auto-build lane until un-deferred">
          {busy === "defer" ? "…" : "Defer"}
        </button>
      )}
      {err && <span className="text-[10px] text-rose-500">failed</span>}
    </div>
  );
}
