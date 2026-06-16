"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";
import { LIFE_FORCE_8 } from "@/lib/ad-tool-config";

interface Angle {
  id: string;
  hook_slug: string;
  lf8_slot: number;
  hook_one_liner: string;
  proof_anchor: { type: string; value: string } | null;
  vibe_tags: string[] | null;
  meta_headline: string;
}

export default function AngleLibraryPage() {
  const workspace = useWorkspace();
  const params = useParams<{ productId: string }>();
  const productId = params.productId;

  const [angles, setAngles] = useState<Angle[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/ads/angles?workspaceId=${workspace.id}&productId=${productId}`,
    );
    if (res.ok) setAngles(await res.json());
    setLoading(false);
  }, [workspace.id, productId]);

  useEffect(() => {
    load();
  }, [load]);

  async function generate() {
    setGenerating(true);
    setError(null);
    const res = await fetch("/api/ads/angles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, productId }),
    });
    if (res.ok) {
      await load();
    } else {
      const d = await res.json().catch(() => ({}));
      setError(d.reason || d.error || "Failed to generate angles");
    }
    setGenerating(false);
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Angle library</h1>
          <p className="mt-1 text-sm text-zinc-500">Validated direct-response angles for this product.</p>
        </div>
        <button
          onClick={generate}
          disabled={generating}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? "Generating…" : "Generate fresh angles"}
        </button>
      </div>

      {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : angles.length === 0 ? (
        <p className="text-sm text-zinc-500">No angles yet. Generate some to get started.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {angles.map((a) => (
            <div
              key={a.id}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  {a.hook_slug}
                </span>
                <span
                  className="rounded bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                  title={LIFE_FORCE_8[a.lf8_slot]}
                >
                  LF8 #{a.lf8_slot}
                </span>
              </div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{a.hook_one_liner}</p>
              {a.proof_anchor?.value && (
                <p className="mt-2 text-xs text-zinc-500">Proof: {a.proof_anchor.value}</p>
              )}
              {a.meta_headline && (
                <p className="mt-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">{a.meta_headline}</p>
              )}
              {Array.isArray(a.vibe_tags) && a.vibe_tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {a.vibe_tags.map((v) => (
                    <span
                      key={v}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800"
                    >
                      {v}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
