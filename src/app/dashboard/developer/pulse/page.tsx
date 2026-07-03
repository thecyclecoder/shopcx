"use client";

/**
 * /dashboard/developer/pulse — the founder-pulse read-only context-
 * reconstitution surface (founder-pulse spec, Phase 3).
 *
 * Owner-gated. Reads /api/developer/pulse (default: cached) and renders
 * the five lenses; every claim carries superscript cite links back to
 * its source (spec detail page, PR, or session digest). A refresh button
 * calls /api/developer/pulse?refresh=1 which recomputes + updates the
 * synthesized-at stamp.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

/**
 * Render a UTC ISO in America/Puerto_Rico (AST, UTC-4, no DST). Duplicated as a
 * local helper because `@/lib/pulse-digest` imports Node's `fs` module (the
 * scripts entrypoint) and cannot be imported into a client component. The two
 * copies must stay in sync — the DB is UTC, display is AST, no DST.
 */
function formatAstTimestamp(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: "America/Puerto_Rico",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface LensClaim {
  claim: string;
  cite_ids: string[];
}
interface Cite {
  kind: "session" | "spec" | "commit" | "pr" | "brain" | "file" | "url";
  ref: string;
  label: string;
}
interface Snapshot {
  subject: string;
  lenses: Record<string, LensClaim[]>;
  cites: Record<string, Cite>;
  synthesized_at: string;
  model: string;
}

const LENSES: Array<{ key: string; heading: string; blurb: string }> = [
  { key: "whats_working", heading: "What's working", blurb: "Threads whose specs already shipped, folded, or are actively building." },
  { key: "where_you_left_off", heading: "Where you left off", blurb: "Genuinely open threads — no matching spec yet, or the spec is still planned." },
  { key: "rabbit_holes", heading: "Rabbit holes", blurb: "Threads you flagged as noise. Ignore unless one deserves a promotion." },
  { key: "next_moves", heading: "Next moves", blurb: "Planned specs prioritized by whether an open thread already references them." },
  { key: "threads_in_flight", heading: "Threads in flight", blurb: "Open threads + in-progress specs + non-terminal build jobs." },
];

function citeHref(cite: Cite): string {
  switch (cite.kind) {
    case "spec":
      return `/dashboard/roadmap/${encodeURIComponent(cite.ref)}`;
    case "pr":
      return cite.label && cite.label.startsWith("http") ? cite.label : `https://github.com/thecyclecoder/shopcx/pull/${cite.ref}`;
    case "commit":
      return `https://github.com/thecyclecoder/shopcx/commit/${cite.ref}`;
    case "url":
      return cite.ref;
    case "session":
    case "brain":
    case "file":
    default:
      return "#";
  }
}

function citeShort(kind: Cite["kind"]): string {
  switch (kind) {
    case "spec":
      return "spec";
    case "pr":
      return "PR";
    case "commit":
      return "sha";
    case "session":
      return "sess";
    case "brain":
      return "brain";
    case "file":
      return "file";
    case "url":
      return "url";
  }
}

export default function PulsePage() {
  const workspace = useWorkspace();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/developer/pulse${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Snapshot;
      setSnapshot(data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (workspace.role === "owner") void load(false);
  }, [workspace.role, load]);

  const stamp = useMemo(() => (snapshot ? formatAstTimestamp(snapshot.synthesized_at) : ""), [snapshot]);

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Pulse</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-lg p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Pulse</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {snapshot ? (
              <>Synthesized {stamp} (AST) · {snapshot.model === "deterministic" ? "deterministic" : `narrated by ${snapshot.model}`}</>
            ) : loading ? (
              <>Synthesizing…</>
            ) : (
              <>No snapshot yet.</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          Failed to load pulse: {err}
        </div>
      )}

      <div className="mt-6 grid gap-6">
        {LENSES.map((lens) => {
          const claims = snapshot?.lenses?.[lens.key] ?? [];
          return (
            <section key={lens.key} className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{lens.heading}</h2>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{lens.blurb}</p>
              {claims.length === 0 ? (
                <p className="mt-3 text-sm italic text-zinc-400 dark:text-zinc-500">
                  {loading ? "…" : "Nothing here right now."}
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {claims.map((c, i) => (
                    <li key={i} className="flex items-baseline gap-1.5 text-sm text-zinc-800 dark:text-zinc-200">
                      <span className="flex-1">{c.claim}</span>
                      <span className="flex shrink-0 items-baseline gap-0.5 text-[10px] text-zinc-400">
                        {c.cite_ids.map((id) => {
                          const cite = snapshot?.cites?.[id];
                          if (!cite) return null;
                          const href = citeHref(cite);
                          const label = citeShort(cite.kind);
                          const external = href.startsWith("http");
                          if (external) {
                            return (
                              <a
                                key={id}
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={cite.label}
                                className="align-super text-[10px] text-indigo-600 hover:underline dark:text-indigo-400"
                              >
                                [{label}]
                              </a>
                            );
                          }
                          return (
                            <Link
                              key={id}
                              href={href}
                              title={cite.label}
                              className="align-super text-[10px] text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              [{label}]
                            </Link>
                          );
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
