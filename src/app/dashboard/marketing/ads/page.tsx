"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface Campaign {
  id: string;
  name: string;
  status: string;
  hero_image_url: string | null;
  created_at: string;
  products?: { title: string } | null;
}

export default function AdsLandingPage() {
  const workspace = useWorkspace();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ads/campaigns?workspaceId=${workspace.id}`);
    if (res.ok) setCampaigns(await res.json());
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-6 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Ads</h1>
      <p className="mb-8 text-sm text-zinc-500">
        Generate direct-response paid-social video ads from your product intelligence.
      </p>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <Link
          href="/dashboard/marketing/ads/avatars"
          className="rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Avatars</h2>
          <p className="mt-1 text-xs text-zinc-500">Manage the on-camera spokesperson characters.</p>
        </Link>
        <Link
          href="/dashboard/marketing/ads/new"
          className="rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">New ad</h2>
          <p className="mt-1 text-xs text-zinc-500">Build a new ad — avatar, product, angle, script.</p>
        </Link>
        <Link
          href="/dashboard/settings/ad-tool"
          className="rounded-lg border border-zinc-200 bg-white p-4 transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Settings</h2>
          <p className="mt-1 text-xs text-zinc-500">Banned words, LF8 targeting, captions, cost cap.</p>
        </Link>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Library</h2>
      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : campaigns.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No ads yet.{" "}
          <Link href="/dashboard/marketing/ads/new" className="text-indigo-600 hover:underline">
            Create your first ad
          </Link>
          .
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/marketing/ads/${c.id}`}
              className="overflow-hidden rounded-lg border border-zinc-200 bg-white transition-colors hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="aspect-video w-full bg-zinc-100 dark:bg-zinc-800">
                {c.hero_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.hero_image_url} alt={c.name} className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                    No preview
                  </div>
                )}
              </div>
              <div className="p-3">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{c.name}</p>
                <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                  <span>{c.products?.title || "—"}</span>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider dark:bg-zinc-800">
                    {c.status}
                  </span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
