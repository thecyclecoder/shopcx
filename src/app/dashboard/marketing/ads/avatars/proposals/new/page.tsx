"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWorkspace } from "@/lib/workspace-context";

interface Product {
  id: string;
  title: string;
  image_url?: string | null;
}

export default function NewProposalsPage() {
  const workspace = useWorkspace();
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/products`);
    setProducts(res.ok ? await res.json() : []);
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  async function suggest() {
    if (!selected) {
      setError("Pick a product first.");
      return;
    }
    setGenerating(true);
    setError(null);
    const res = await fetch("/api/ads/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, productId: selected }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      setError(json.reason || json.error || "Failed to generate proposals.");
      setGenerating(false);
      return;
    }
    router.push("/dashboard/marketing/ads/avatars");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Suggest avatars</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Pick a product and we'll propose on-brand avatar archetypes from your buyer demographics.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">Product</label>
        {loading ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading products…</p>
        ) : (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          >
            <option value="">Select a product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        No Higgsfield cost — just an Opus call.
      </p>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={suggest}
          disabled={generating || loading}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {generating ? "Generating…" : "Suggest avatars for this product"}
        </button>
        <button
          onClick={() => router.push("/dashboard/marketing/ads/avatars")}
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
