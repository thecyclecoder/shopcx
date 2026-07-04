"use client";

// Research › Teardowns — the owner-facing curated gallery of successful teardowns
// (docs/brain/specs/research-teardowns-view.md, Phase 1). Reads GET /api/research/teardowns.
// Lists workspace research_urls rows carrying a structured TeardownRecipe (`teardown IS NOT NULL`)
// worthiest-first (highest `ad_count`). Each row surfaces brand · url · funnel_type · ad_count ·
// captured date + a 'View HTML' action linking to the founder-approved Showcase board at
// /showcase/tools/teardowns/examples/[id] (Phase 2). Complements the broader 'Landers' list
// (all classified URLs) with just the ones worth studying. SUPERSEDES the legacy
// lander_snapshots teardowns surface (the earlier funnel-filmstrip view that used to live here).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface TeardownRow {
  id: string;
  url: string;
  brand: string | null;
  domain: string;
  funnel_type: string | null;
  ad_count: number;
  captured_at: string | null;
  showcase_href: string;
}

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
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function ResearchTeardownsPage() {
  const workspace = useWorkspace();
  const [rows, setRows] = useState<TeardownRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = workspace.role === "owner";

  const load = useCallback(async () => {
    if (!isOwner) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ workspaceId: workspace.id });
      const res = await fetch(`/api/research/teardowns?${qs.toString()}`);
      const body = (await res.json().catch(() => ({}))) as {
        teardowns?: TeardownRow[];
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? `error ${res.status}`);
        setRows([]);
      } else {
        setRows(body.teardowns ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [isOwner, workspace.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
        <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Teardowns</h1>
        <p className="text-sm text-zinc-500">This surface is owner-only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Teardowns</h1>
      <p className="mb-6 text-sm text-zinc-500">
        The curated gallery of Rhea&apos;s successful teardowns — competitor landers with a
        structured recipe (funnel architecture, reason sequence, lever inventory, offer anatomy),
        worthiest-first by ad_count. Each opens the founder-approved HTML board on the Showcase.
      </p>

      <div className="mb-4 text-xs text-zinc-400">
        {loading && rows === null
          ? "Loading…"
          : `${rows?.length ?? 0} teardown${(rows?.length ?? 0) === 1 ? "" : "s"}`}
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {rows !== null && rows.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          No teardowns yet. A row lands here once Rhea has judged a lander &lsquo;worthy&rsquo; and
          written its structured recipe. See the sibling{" "}
          <Link href="/dashboard/research/landers" className="underline">
            Landers
          </Link>{" "}
          list for all captured URLs.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2">Brand</th>
                <th className="px-4 py-2">URL</th>
                <th className="px-4 py-2">Funnel type</th>
                <th className="px-4 py-2">Ad count</th>
                <th className="px-4 py-2">Captured</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((r) => (
                <tr key={r.id} className="bg-white dark:bg-zinc-950">
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
                      >
                        {shortHost(r.url)}
                        {pathOf(r.url)}
                      </a>
                      <span className="text-[11px] text-zinc-500">{r.domain}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                    {r.funnel_type ? (
                      <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                        {r.funnel_type}
                      </span>
                    ) : (
                      <span className="text-xs italic text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{r.ad_count}</td>
                  <td className="px-4 py-2 text-zinc-500">{fmtDate(r.captured_at)}</td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={r.showcase_href}
                      className="rounded bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-500"
                    >
                      View HTML →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
