"use client";

import { useCallback, useEffect, useState } from "react";

// The Agents-hub / platform-profile card for a director's ONE active directive
// ([[../../../docs/brain/specs/director-executable-plans-and-priority-hub-pip]] Phase 1).
//
// Mirrors how the standing pass already headlines the directive — the always-visible hub surface so
// the CEO sees, at a glance, the plan the director is running first, its steps, the gate badge ("builds
// GATED until <spec> ships"), and a clear affordance. Renders nothing when there's no active directive.

interface DirectorDirective {
  id: string;
  workspace_id: string;
  director_function: string;
  summary: string;
  steps: string[];
  gate_builds_until: string | null;
  status: "active" | "done" | "cleared";
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

function elapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function DirectiveCard({ functionSlug, title }: { functionSlug: string; title?: string }) {
  const [directive, setDirective] = useState<DirectorDirective | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetch(`/api/director/directive?function=${encodeURIComponent(functionSlug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: { directive: DirectorDirective | null }) => {
        setDirective(d.directive);
        setErr(null);
      })
      .catch(() => setErr("Couldn't load the active directive."))
      .finally(() => setLoading(false));
  }, [functionSlug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onClear = useCallback(async () => {
    if (!directive) return;
    if (!window.confirm(`Clear ${title ?? functionSlug}'s active directive? Her standing pass returns to routine.`)) return;
    setClearing(true);
    try {
      const res = await fetch("/api/director/directive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: directive.id, action: "clear" }),
      });
      if (!res.ok) throw new Error(`Clear failed (${res.status})`);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }, [directive, functionSlug, title, refresh]);

  if (loading && !directive) return null; // first paint: silent until we know one way or the other
  if (!directive) return null; // no active directive → no card (spec: "with no active directive the card is absent")

  const label = title ?? functionSlug;
  const stepCount = directive.steps?.length ?? 0;

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 px-4 py-3.5 dark:border-indigo-900/60 dark:bg-indigo-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base leading-none">🎯</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">
              {label}&apos;s active directive
            </span>
            {directive.gate_builds_until && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                builds GATED until {directive.gate_builds_until} ships
              </span>
            )}
            <span className="text-[11px] text-zinc-400">handed to her {elapsed(directive.created_at)}</span>
          </div>
          <p className="mt-1.5 text-sm text-zinc-800 dark:text-zinc-200">{directive.summary}</p>
        </div>
        <button
          onClick={onClear}
          disabled={clearing}
          className="rounded-md border border-zinc-300 px-2.5 py-1 text-[12px] font-medium text-zinc-600 transition-colors hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-rose-800 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
          title="End the active directive — her standing pass returns to routine"
        >
          {clearing ? "Clearing…" : "Clear"}
        </button>
      </div>

      {stepCount > 0 && (
        <ol className="mt-3 space-y-1.5">
          {directive.steps.map((s, i) => (
            <li key={i} className="flex gap-2 text-[12px] text-zinc-700 dark:text-zinc-300">
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-mono text-[10px] font-semibold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                {i + 1}
              </span>
              <span className="min-w-0">{s}</span>
            </li>
          ))}
        </ol>
      )}

      {err && <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">{err}</p>}
    </div>
  );
}
