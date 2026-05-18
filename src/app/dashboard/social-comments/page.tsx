"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface SocialCommentRow {
  id: string;
  meta_page_id: string;
  meta_comment_id: string;
  meta_sender_id: string;
  meta_sender_name: string | null;
  meta_sender_username: string | null;
  body: string;
  is_ad: boolean;
  page_type: string;
  ad_id: string | null;
  sentiment: string | null;
  matched_product_id: string | null;
  status: string;
  moderation_source: string | null;
  ai_action: string | null;
  created_at: string;
  meta_pages: { meta_page_name: string | null; platform: string; page_type: string } | null;
  meta_post_cache: { permalink_url: string | null; message: string | null; image_url: string | null } | null;
  products: { title: string; handle: string } | null;
}

interface MetaPageOption {
  id: string;
  meta_page_name: string | null;
  platform: string;
}

const STATUS_OPTIONS = ["all", "open", "escalated", "replied", "hidden", "deleted", "ignored"] as const;
const SENTIMENT_OPTIONS = ["all", "positive", "negative", "neutral", "spam", "abusive"] as const;

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  replied: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  hidden: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  deleted: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  escalated: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  ignored: "bg-zinc-50 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500",
};

const SENTIMENT_COLORS: Record<string, string> = {
  positive: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  negative: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-400",
  neutral: "bg-zinc-50 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
  spam: "bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-400",
  abusive: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400",
};

export default function SocialCommentsListPage() {
  const { id: workspaceId } = useWorkspace();
  const [rows, setRows] = useState<SocialCommentRow[]>([]);
  const [pages, setPages] = useState<MetaPageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const [status, setStatus] = useState<string>("open");
  const [sentiment, setSentiment] = useState<string>("all");
  const [pageId, setPageId] = useState<string>("all");
  const [pageType, setPageType] = useState<string>("all");
  const [ad, setAd] = useState<string>("all");

  const loadPages = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspaceId}/meta-pages`);
    const data = await res.json();
    setPages(data.pages || []);
  }, [workspaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status !== "all") qs.set("status", status);
    if (sentiment !== "all") qs.set("sentiment", sentiment);
    if (pageId !== "all") qs.set("page_id", pageId);
    if (pageType !== "all") qs.set("page_type", pageType);
    if (ad !== "all") qs.set("ad", ad);
    qs.set("limit", "100");
    const res = await fetch(`/api/workspaces/${workspaceId}/social-comments?${qs.toString()}`);
    const data = await res.json();
    setRows(data.comments || []);
    setTotal(data.total || 0);
    setLoading(false);
  }, [workspaceId, status, sentiment, pageId, pageType, ad]);

  useEffect(() => {
    void loadPages();
  }, [loadPages]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">
              Social comments
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Public comment moderation across Facebook + Instagram. {total} total in current filter.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/social-comments/analysis"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              AI analysis
            </Link>
            <Link
              href="/dashboard/social-comments/banned"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Banned users
            </Link>
            <Link
              href="/dashboard/settings/integrations/meta"
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Manage pages
            </Link>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <FilterSelect label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
          <FilterSelect label="Sentiment" value={sentiment} options={SENTIMENT_OPTIONS} onChange={setSentiment} />
          <FilterSelect
            label="Page"
            value={pageId}
            options={["all", ...pages.map(p => p.id)]}
            labels={{
              all: "All pages",
              ...Object.fromEntries(pages.map(p => [p.id, p.meta_page_name || p.id])),
            }}
            onChange={setPageId}
          />
          <FilterSelect label="Page type" value={pageType} options={["all", "brand", "creator"]} onChange={setPageType} />
          <FilterSelect
            label="Source"
            value={ad}
            options={["all", "true", "false"]}
            labels={{ all: "All posts", true: "Ads only", false: "Organic only" }}
            onChange={setAd}
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No comments match this filter.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2 font-medium">Page</th>
                <th className="px-4 py-2 font-medium">Post</th>
                <th className="px-4 py-2 font-medium">Commenter</th>
                <th className="px-4 py-2 font-medium">Comment</th>
                <th className="px-4 py-2 font-medium">Sentiment</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr
                  key={row.id}
                  className="border-t border-zinc-200 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/social-comments/${row.id}`}
                      className="block"
                    >
                      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {row.meta_pages?.meta_page_name || "Unknown page"}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-400">
                          {row.meta_pages?.platform || "facebook"}
                        </span>
                        <span className="text-xs text-zinc-500">{row.page_type}</span>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-[200px]">
                    <Link href={`/dashboard/social-comments/${row.id}`} className="block">
                      <div className="flex items-center gap-2">
                        {row.is_ad ? (
                          <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
                            Ad
                          </span>
                        ) : (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                            Organic
                          </span>
                        )}
                        {row.products && (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                            {row.products.title.slice(0, 24)}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-zinc-500">
                        {row.meta_post_cache?.message || "(no caption)"}
                      </p>
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-[160px]">
                    <Link href={`/dashboard/social-comments/${row.id}`} className="block">
                      <div className="text-sm text-zinc-900 dark:text-zinc-100">
                        {row.meta_sender_name || "(anon)"}
                      </div>
                      {row.meta_sender_username && (
                        <div className="text-xs text-zinc-500">@{row.meta_sender_username}</div>
                      )}
                    </Link>
                  </td>
                  <td className="px-4 py-3 max-w-[400px]">
                    <Link href={`/dashboard/social-comments/${row.id}`} className="block">
                      <p className="line-clamp-2 text-sm text-zinc-700 dark:text-zinc-300">{row.body}</p>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {row.sentiment ? (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          SENTIMENT_COLORS[row.sentiment] || SENTIMENT_COLORS.neutral
                        }`}
                      >
                        {row.sentiment}
                      </span>
                    ) : (
                      <span className="text-xs text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_COLORS[row.status] || STATUS_COLORS.open
                      }`}
                    >
                      {row.status}
                    </span>
                    {row.moderation_source === "ai_suggested" && (
                      <span className="ml-1 rounded-full bg-purple-50 px-1.5 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-950 dark:text-purple-400">
                        AI suggest
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-zinc-500">
                    {formatRelative(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface FilterSelectProps {
  label: string;
  value: string;
  options: readonly string[] | string[];
  labels?: Record<string, string>;
  onChange: (value: string) => void;
}

function FilterSelect({ label, value, options, labels, onChange }: FilterSelectProps) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span>{label}:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
      >
        {options.map(opt => (
          <option key={opt} value={opt}>
            {labels?.[opt] || opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
