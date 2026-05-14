"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface MetaPageRow {
  id: string;
  platform: "facebook" | "instagram";
  meta_page_id: string;
  meta_page_name: string | null;
  meta_instagram_id: string | null;
  page_type: "brand" | "creator";
  ai_moderate_ad_comments: boolean;
  ai_moderate_organic_comments: boolean;
  is_active: boolean;
  connected_at: string;
  last_synced_at: string | null;
  webhook_verify_token: string | null;
}

export default function MetaPagesSettingsPage() {
  const { id: workspaceId } = useWorkspace();
  const [pages, setPages] = useState<MetaPageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPages = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspaceId}/meta-pages`);
    const data = await res.json();
    setPages(data.pages || []);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  async function updatePage(pageId: string, body: Partial<MetaPageRow>) {
    setSavingId(pageId);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/meta-pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Update failed");
        return;
      }
      await loadPages();
    } finally {
      setSavingId(null);
    }
  }

  async function disconnect(pageId: string) {
    if (!confirm("Disconnect this page? Comments will stop being moderated.")) return;
    setSavingId(pageId);
    await fetch(`/api/workspaces/${workspaceId}/meta-pages/${pageId}`, { method: "DELETE" });
    await loadPages();
    setSavingId(null);
  }

  async function connectMeta() {
    const res = await fetch("/api/meta/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    const data = await res.json();
    if (data.url) window.location.href = data.url;
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link
            href="/dashboard/settings/integrations"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            ← Back to integrations
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
            Meta pages
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Facebook + Instagram pages connected for DMs and comment moderation. Each page has its own moderation policy.
          </p>
        </div>
        <button
          type="button"
          onClick={connectMeta}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
        >
          Connect a page
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
          Loading…
        </div>
      ) : pages.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
          <p className="text-sm text-zinc-500">No pages connected yet.</p>
          <button
            type="button"
            onClick={connectMeta}
            className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Connect your first page
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {pages.map(page => (
            <PageCard
              key={page.id}
              page={page}
              saving={savingId === page.id}
              onUpdate={updates => updatePage(page.id, updates)}
              onDisconnect={() => disconnect(page.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PageCardProps {
  page: MetaPageRow;
  saving: boolean;
  onUpdate: (updates: Partial<MetaPageRow>) => void;
  onDisconnect: () => void;
}

function PageCard({ page, saving, onUpdate, onDisconnect }: PageCardProps) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100">
              {page.meta_page_name || page.meta_page_id}
            </h3>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              {page.platform === "instagram" ? "Instagram" : "Facebook"}
            </span>
            {page.is_active ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                Active
              </span>
            ) : (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Disconnected
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Page ID: <span className="font-mono">{page.meta_page_id}</span>
            {page.meta_instagram_id && (
              <>
                {" "}· IG: <span className="font-mono">{page.meta_instagram_id}</span>
              </>
            )}
          </p>
        </div>
        {page.is_active && (
          <button
            type="button"
            onClick={onDisconnect}
            disabled={saving}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
          >
            Disconnect
          </button>
        )}
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Page type</label>
          <p className="mt-0.5 text-xs text-zinc-500">
            Brand pages moderate ad + organic. Creator pages moderate ads only by default.
          </p>
          <select
            value={page.page_type}
            onChange={e => onUpdate({ page_type: e.target.value as "brand" | "creator" })}
            disabled={saving}
            className="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="brand">Brand</option>
            <option value="creator">Creator</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">AI moderation</label>
          <p className="mt-0.5 text-xs text-zinc-500">Choose what AI moderates on this page.</p>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={page.ai_moderate_ad_comments}
                onChange={e => onUpdate({ ai_moderate_ad_comments: e.target.checked })}
                disabled={saving}
                className="rounded border-zinc-300 dark:border-zinc-700"
              />
              <span>Comments on ads</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={page.ai_moderate_organic_comments}
                onChange={e => onUpdate({ ai_moderate_organic_comments: e.target.checked })}
                disabled={saving}
                className="rounded border-zinc-300 dark:border-zinc-700"
              />
              <span>Comments on organic posts</span>
            </label>
          </div>
        </div>
      </div>

      {page.webhook_verify_token && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Webhook configuration
          </summary>
          <div className="mt-2 rounded-md bg-zinc-50 p-3 text-xs dark:bg-zinc-800">
            <p className="font-mono break-all">Callback URL: https://shopcx.ai/api/webhooks/meta</p>
            <p className="mt-1 font-mono break-all">Verify token: {page.webhook_verify_token}</p>
            <p className="mt-2 text-zinc-500">Subscribe to: messages, feed, mention, comments</p>
          </div>
        </details>
      )}
    </div>
  );
}
