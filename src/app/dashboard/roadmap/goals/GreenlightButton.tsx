"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

/**
 * The CEO's one-click Greenlight / Decline / Revert button trio for the goal card
 * (goal-greenlight-button-and-author-writes-db Phase 1). Replaces the markdown-commit-then-deploy
 * activation path with a single DB write that lands in the row.
 *
 * - `proposed` → renders [Greenlight] [Decline] (one click each, no confirmation modal — mirrors the
 *   approval-routing-engine Approve action's shape).
 * - `greenlit` → renders [Revert] iff no child milestone has progress; once any spec lands the button
 *   hides itself and the goal is pinned forward (the safety rail lives server-side too — the route
 *   re-checks and 409s).
 * - any other status → renders nothing.
 *
 * Non-owners (any non-CEO viewer) see nothing — the route enforces this server-side as well; the
 * client hide is a UX nicety.
 *
 * Designed to be rendered INSIDE a `<Link>` on the goals board card; the click handler stops the
 * navigation so a Greenlight tap doesn't also navigate into the goal detail.
 */
export function GreenlightButton({
  slug,
  status,
  hasProgress,
  compact = false,
}: {
  slug: string;
  status: "proposed" | "greenlit" | "complete";
  /** true iff any child milestone has rolled past `planned` (i.e. any child spec is in_progress|shipped). */
  hasProgress: boolean;
  /** Smaller padding for the list card; default sizing for the detail sidebar. */
  compact?: boolean;
}) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState<"greenlight" | "decline" | "revert" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (workspace.role !== "owner") return null;
  if (status !== "proposed" && status !== "greenlit") return null;
  if (status === "greenlit" && hasProgress) return null;

  async function post(path: string, kind: "greenlight" | "decline" | "revert") {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `failed (${res.status})`);
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setBusy(null);
    }
  }

  const onGreenlight = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void post("/api/roadmap/goal/greenlight", "greenlight");
  };
  const onDecline = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void post("/api/roadmap/goal/decline", "decline");
  };
  const onRevert = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void post("/api/roadmap/goal/ungreenlight", "revert");
  };

  const sz = compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {status === "proposed" && (
          <>
            <button
              type="button"
              onClick={onGreenlight}
              disabled={!!busy}
              className={`rounded-md bg-emerald-600 font-medium text-white hover:bg-emerald-700 disabled:opacity-50 ${sz}`}
              title="Activate this goal (CEO greenlight — a single DB flag). Reversible until progress lands."
            >
              {busy === "greenlight" ? "…" : "Greenlight"}
            </button>
            <button
              type="button"
              onClick={onDecline}
              disabled={!!busy}
              className={`rounded-md border border-zinc-300 font-medium text-zinc-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-rose-900/40 dark:hover:bg-rose-950/30 disabled:opacity-50 ${sz}`}
              title="Decline this proposed goal (flips to folded; the row stays for audit)."
            >
              {busy === "decline" ? "…" : "Decline"}
            </button>
          </>
        )}
        {status === "greenlit" && (
          <button
            type="button"
            onClick={onRevert}
            disabled={!!busy}
            className={`rounded-md border border-zinc-300 font-medium text-zinc-500 hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-amber-900/40 dark:hover:bg-amber-950/30 disabled:opacity-50 ${sz}`}
            title="Revert to proposed (allowed only while no child milestone has moved past planned)."
          >
            {busy === "revert" ? "…" : "Revert"}
          </button>
        )}
      </div>
      {error && <span className="text-[10px] text-rose-600">{error}</span>}
    </div>
  );
}
