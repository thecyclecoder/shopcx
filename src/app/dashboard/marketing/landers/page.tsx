"use client";

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Lander {
  id: string;
  variant: string;
  slug: string;
  headline: string | null;
  hero_kind: string | null;
  status: string;
  updated_at: string;
  product_title: string | null;
  url: string | null;
}

const VARIANT_LABEL: Record<string, string> = { advertorial: "Advertorial", beforeafter: "Before / After" };

export default function LandersPage() {
  const workspace = useWorkspace();
  const [landers, setLanders] = useState<Lander[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ads/landers?workspaceId=${workspace.id}`);
    if (res.ok) setLanders((await res.json()).landers || []);
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => { load(); }, [load]);

  const copy = async (url: string, id: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(id); setTimeout(() => setCopied(null), 1500); } catch {}
  };

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Landers</h1>
      <p className="mb-8 text-sm text-zinc-500">
        Auto-generated, ad-matched landing pages on your in-house storefront. Advertorial and
        before/after ads point here; testimonial/authority/big-claim ads go straight to the PDP.
      </p>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : landers.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No landers yet. They&apos;re generated automatically when an ad campaign is ready
          (advertorial / before-after archetypes).
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Headline</th>
                <th className="px-4 py-3">URL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {landers.map((l) => (
                <tr key={l.id} className="bg-white dark:bg-zinc-950">
                  <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">{l.product_title || "—"}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                      {VARIANT_LABEL[l.variant] || l.variant}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-zinc-600 dark:text-zinc-400" title={l.headline || ""}>
                    {l.headline || "—"}
                  </td>
                  <td className="px-4 py-3">
                    {l.url ? (
                      <div className="flex items-center gap-2">
                        <a href={l.url} target="_blank" rel="noopener noreferrer" className="max-w-sm truncate text-indigo-600 hover:underline dark:text-indigo-400">
                          {l.url.replace(/^https:\/\//, "")}
                        </a>
                        <button
                          onClick={() => copy(l.url!, l.id)}
                          className="shrink-0 rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          {copied === l.id ? "Copied" : "Copy"}
                        </button>
                      </div>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
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
