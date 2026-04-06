"use client";

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface ProductIntelligence {
  id: string;
  product_id: string;
  title: string;
  content: string;
  source: string;
  source_urls: string[];
  created_at: string;
  updated_at: string;
  products: { id: string; title: string; image_url: string | null; shopify_product_id: string } | null;
}

export default function ProductIntelligenceDetailPage() {
  const workspace = useWorkspace();
  const { id: piId } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ProductIntelligence | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Enrich
  const [enrichContent, setEnrichContent] = useState("");
  const [enriching, setEnriching] = useState(false);
  const [scrapeUrl, setScrapeUrl] = useState("");
  const [scraping, setScraping] = useState(false);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`);
    if (res.ok) {
      const d = await res.json();
      setData(d);
      setEditContent(d.content);
      setEditTitle(d.title);
    }
    setLoading(false);
  }, [workspace.id, piId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: editTitle, content: editContent }),
    });
    setSaving(false);
    setSaved(true);
    setEditing(false);
    setTimeout(() => setSaved(false), 2000);
    await fetchData();
  };

  const handleEnrich = async () => {
    if (!enrichContent.trim()) return;
    setEnriching(true);
    await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ append_content: enrichContent.trim() }),
    });
    setEnriching(false);
    setEnrichContent("");
    await fetchData();
  };

  const handleScrape = async () => {
    if (!scrapeUrl) return;
    setScraping(true);
    try {
      const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/scrape-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: scrapeUrl }),
      });
      if (res.ok) {
        const scraped = await res.json();
        // Append scraped content + add URL
        await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            append_content: `Source: ${scrapeUrl}\n\n${scraped.content}`,
            add_url: scrapeUrl,
          }),
        });
        setScrapeUrl("");
        await fetchData();
      }
    } catch {}
    setScraping(false);
  };

  const handleDelete = async () => {
    if (!confirm("Delete this product intelligence? This cannot be undone.")) return;
    await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, { method: "DELETE" });
    router.push("/dashboard/products");
  };

  if (loading) return <div className="mx-auto max-w-4xl px-4 py-6"><p className="text-sm text-zinc-400">Loading...</p></div>;
  if (!data) return <div className="mx-auto max-w-4xl px-4 py-6"><p className="text-sm text-red-500">Not found</p></div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <Link href="/dashboard/products" className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700">
        &larr; Back to Products
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div className="flex items-center gap-4">
          {data.products?.image_url ? (
            <img src={data.products.image_url} alt="" className="h-16 w-16 rounded-lg object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800">
              <svg className="h-8 w-8 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">{data.title}</h1>
            <p className="text-sm text-zinc-500">{data.products?.title || "No product linked"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-sm text-green-600">Saved</span>}
          {!editing ? (
            <button onClick={() => setEditing(true)} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600">Edit</button>
          ) : (
            <>
              <button onClick={handleSave} disabled={saving} className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
              <button onClick={() => { setEditing(false); setEditContent(data.content); setEditTitle(data.title); }} className="text-xs text-zinc-500 hover:text-zinc-700">Cancel</button>
            </>
          )}
          <button onClick={handleDelete} className="text-xs text-red-400 hover:text-red-600">Delete</button>
        </div>
      </div>

      {/* Metadata */}
      <div className="mb-6 flex flex-wrap gap-3 text-xs text-zinc-500">
        <span className={`rounded px-2 py-0.5 font-medium ${
          data.source === "shopgrowth" ? "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300"
          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
        }`}>
          {data.source === "shopgrowth" ? "ShopGrowth" : data.source === "url_scrape" ? "URL Scrape" : "Manual"}
        </span>
        <span>Created: {new Date(data.created_at).toLocaleDateString()}</span>
        <span>Updated: {new Date(data.updated_at).toLocaleDateString()}</span>
        <span>{data.content.length.toLocaleString()} characters</span>
        {data.source_urls.length > 0 && <span>{data.source_urls.length} source URL{data.source_urls.length !== 1 ? "s" : ""}</span>}
      </div>

      {/* Source URLs */}
      {data.source_urls.length > 0 && (
        <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">Source URLs</h3>
          <div className="space-y-1">
            {data.source_urls.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block text-xs text-indigo-500 hover:text-indigo-700 truncate">{url}</a>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Intelligence Content</h3>
        </div>
        {editing ? (
          <div className="p-5">
            <div className="mb-3">
              <label className="block text-xs font-medium text-zinc-500 mb-1">Title</label>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
              />
            </div>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={30}
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
          </div>
        ) : (
          <div className="p-5 prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300 font-mono">
            {data.content}
          </div>
        )}
      </div>

      {/* Enrich */}
      <div className="space-y-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Enrich Intelligence</h3>
          <p className="text-xs text-zinc-400 mb-3">Paste additional content (blog post, updated ShopGrowth export, etc.) to append to the existing intelligence.</p>
          <textarea
            value={enrichContent}
            onChange={(e) => setEnrichContent(e.target.value)}
            rows={6}
            placeholder="Paste additional content here..."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 mb-2"
          />
          <button
            onClick={handleEnrich}
            disabled={enriching || !enrichContent.trim()}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {enriching ? "Appending..." : "Append to Intelligence"}
          </button>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Enrich from URL</h3>
          <p className="text-xs text-zinc-400 mb-3">Scrape a webpage and append its content to the intelligence.</p>
          <div className="flex gap-2">
            <input
              value={scrapeUrl}
              onChange={(e) => setScrapeUrl(e.target.value)}
              placeholder="https://example.com/blog/product-article"
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            />
            <button
              onClick={handleScrape}
              disabled={scraping || !scrapeUrl}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-600 disabled:opacity-50"
            >
              {scraping ? "Scraping..." : "Scrape & Append"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
