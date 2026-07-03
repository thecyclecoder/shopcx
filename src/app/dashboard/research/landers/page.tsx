"use client";

// Research › Landers — the owner-facing window onto Rhea's URL sensor output
// (docs/brain/specs/research-landers-viewer.md, Phase 2). Reads GET /api/research/landers
// (owner-only). Lists the workspace's research_urls worthiest-first (highest `ad_count`),
// each row's classification + teardown_verdict as pills, and marks rows carrying a structured
// TeardownRecipe as clickable — clicking opens /dashboard/research/landers/[id] with the
// teardown board. Distinct from the legacy /dashboard/research/teardowns page which reads
// lander_snapshots.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface LanderRow {
  id: string;
  url: string;
  brand: string | null;
  domain: string;
  classification: string | null;
  ad_count: number;
  teardown_verdict: string;
  first_seen: string | null;
  last_seen: string | null;
  has_teardown: boolean;
}

const CLASSIFICATION_BADGE: Record<string, string> = {
  advertorial: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  quiz: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  generic_pdp: "bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  homepage: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  spam: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  unviewable: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  excluded: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  checkout: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

const VERDICT_BADGE: Record<string, string> = {
  worthy: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  not_worthy: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  unreviewed: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const CLASSIFICATION_OPTIONS = [
  "advertorial",
  "quiz",
  "generic_pdp",
  "homepage",
  "spam",
  "unviewable",
  "excluded",
  "checkout",
];

const VERDICT_OPTIONS = ["worthy", "not_worthy", "unreviewed"];

function shortHost(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
function pathOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

export default function ResearchLandersPage() {
  const workspace = useWorkspace();
  const [rows, setRows] = useState<LanderRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classification, setClassification] = useState<string>("");
  const [verdict, setVerdict] = useState<string>("");

  const isOwner = workspace.role === "owner";

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ workspaceId: workspace.id });
      if (classification) qs.set("classification", classification);
      if (verdict) qs.set("verdict", verdict);
      const res = await fetch(`/api/research/landers?${qs.toString()}`);
      const body = (await res.json().catch(() => ({}))) as {
        landers?: LanderRow[];
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `error ${res.status}`);
        setRows([]);
      } else {
        setRows(body.landers ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [isOwner, workspace.id, classification, verdict]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const total = rows?.length ?? 0;
    const withTeardown = (rows ?? []).filter((r) => r.has_teardown).length;
    return { total, withTeardown };
  }, [rows]);

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Landers</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Landers</h1>
      <p className="mb-6 text-sm text-zinc-500">
        The competitor lander URLs the ad scout has surfaced, worthiest-first (highest ad_count).
        Rows carrying a structured teardown are clickable — open one to see Rhea&apos;s funnel
        architecture, reason sequence, lever chips, offer anatomy, and transferable pattern.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="text-xs uppercase tracking-wide text-zinc-500">Classification</label>
        <select
          value={classification}
          onChange={(e) => setClassification(e.target.value)}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All</option>
          {CLASSIFICATION_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="text-xs uppercase tracking-wide text-zinc-500">Verdict</label>
        <select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value)}
          className="rounded border border-zinc-200 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">All</option>
          {VERDICT_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">
          {loading
            ? "Loading…"
            : `${counts.total} lander${counts.total === 1 ? "" : "s"} · ${counts.withTeardown} with teardown`}
        </span>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No landers match this filter. Rhea&apos;s URL sensor upserts one row per distinct ad
          destination — landers appear here once the ad scout has captured any creatives.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2">Brand</th>
                <th className="px-4 py-2">URL</th>
                <th className="px-4 py-2">Classification</th>
                <th className="px-4 py-2">Ad count</th>
                <th className="px-4 py-2">Verdict</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => {
                const rowClasses = r.has_teardown
                  ? "cursor-pointer bg-white transition-colors hover:bg-zinc-50 dark:bg-zinc-950 dark:hover:bg-zinc-900"
                  : "bg-white dark:bg-zinc-950";
                const detailHref = `/dashboard/research/landers/${r.id}`;
                return (
                  <tr key={r.id} className={rowClasses}>
                    <td className="px-4 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                      {r.brand || <span className="italic text-zinc-400">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-col">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-zinc-900 hover:underline dark:text-zinc-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {shortHost(r.url)}
                          {pathOf(r.url)}
                        </a>
                        <span className="text-[11px] text-zinc-500">{r.domain}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      {r.classification ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            CLASSIFICATION_BADGE[r.classification] ||
                            "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                          }`}
                        >
                          {r.classification}
                        </span>
                      ) : (
                        <span className="text-xs italic text-zinc-400">unclassified</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.ad_count}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          VERDICT_BADGE[r.teardown_verdict] || ""
                        }`}
                      >
                        {r.teardown_verdict}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right">
                      {r.has_teardown ? (
                        <Link
                          href={detailHref}
                          className="rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                        >
                          Open teardown →
                        </Link>
                      ) : (
                        <Link
                          href={detailHref}
                          className="text-xs text-zinc-500 hover:underline"
                        >
                          Details
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
