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

  // Labeled URLs
  const [labeledUrls, setLabeledUrls] = useState<{ url: string; label: string }[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [newUrlLabel, setNewUrlLabel] = useState("PDP");
  const [savingUrls, setSavingUrls] = useState(false);
  const URL_LABELS = ["Science", "Ingredients", "How It Works", "Reviews", "PDP"];

  // Macro Audit
  const [auditing, setAuditing] = useState(false);
  const [auditJobId, setAuditJobId] = useState<string | null>(null);
  const [auditProgress, setAuditProgress] = useState<{ total: number; completed: number; status: string }>({ total: 0, completed: 0, status: "pending" });
  const [auditResults, setAuditResults] = useState<{
    macro_id: string; macro_name: string; category: string; active: boolean;
    original: string; rewritten: string; rewritten_html: string; changes: string[]; accuracy_issues: string[];
    issues_detected: string[]; has_changes: boolean;
  }[] | null>(null);
  const [auditApplied, setAuditApplied] = useState<Set<string>>(new Set());
  const [auditApplying, setAuditApplying] = useState(false);

  // Content collapsed
  const [contentExpanded, setContentExpanded] = useState(false);

  const fetchData = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`);
    if (res.ok) {
      const d = await res.json();
      setData(d);
      setEditContent(d.content);
      setEditTitle(d.title);
      setLabeledUrls((d as Record<string, unknown>).labeled_urls as { url: string; label: string }[] || []);
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

      {/* Labeled URLs */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Product URLs</h3>
        <p className="text-[10px] text-zinc-400 mb-3">These URLs are referenced by AI when rewriting macros.</p>
        {labeledUrls.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {labeledUrls.map((lu, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300 w-20 text-center shrink-0">{lu.label}</span>
                <a href={lu.url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-500 hover:text-indigo-700 truncate flex-1">{lu.url}</a>
                <button onClick={async () => {
                  const updated = labeledUrls.filter((_, j) => j !== i);
                  setLabeledUrls(updated);
                  await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, {
                    method: "PATCH", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ labeled_urls: updated }),
                  });
                }} className="text-[10px] text-red-400 hover:text-red-600 shrink-0">Remove</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <select value={newUrlLabel} onChange={e => setNewUrlLabel(e.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {URL_LABELS.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://superfoodscompany.com/..."
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" />
          <button onClick={async () => {
            if (!newUrl) return;
            const updated = [...labeledUrls, { url: newUrl, label: newUrlLabel }];
            setLabeledUrls(updated);
            setNewUrl("");
            setSavingUrls(true);
            await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}`, {
              method: "PATCH", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ labeled_urls: updated }),
            });
            setSavingUrls(false);
          }} disabled={!newUrl || savingUrls}
            className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-50">
            {savingUrls ? "..." : "Add"}
          </button>
        </div>
      </div>

      {/* Content (collapsible) */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <button
          onClick={() => setContentExpanded(!contentExpanded)}
          className="flex w-full items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800 text-left"
        >
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Intelligence Content</h3>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">{data.content.length.toLocaleString()} chars</span>
            <span className={`text-zinc-400 transition-transform ${contentExpanded ? "rotate-90" : ""}`}>&#9656;</span>
          </div>
        </button>
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
        ) : contentExpanded ? (
          <div className="p-5 prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300 font-mono max-h-[500px] overflow-y-auto">
            {data.content}
          </div>
        ) : null}
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
        {/* Macro Audit */}
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Audit Macros</h3>
              <p className="text-xs text-zinc-400">Compare macros against product intelligence. Sonnet rewrites inaccurate or outdated macros.</p>
            </div>
            <button
              onClick={async () => {
                setAuditing(true);
                setAuditResults(null);
                setAuditApplied(new Set());
                setAuditProgress({ total: 0, completed: 0, status: "pending" });
                try {
                  const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}/audit-macros`, { method: "POST" });
                  if (res.ok) {
                    const { job_id } = await res.json();
                    setAuditJobId(job_id);
                    // Poll for progress
                    const poll = setInterval(async () => {
                      const pollRes = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}/audit-macros?job_id=${job_id}`);
                      if (pollRes.ok) {
                        const job = await pollRes.json();
                        setAuditProgress({ total: job.total, completed: job.completed, status: job.status });
                        if (job.status === "completed") {
                          clearInterval(poll);
                          setAuditResults(job.results || []);
                          setAuditing(false);
                        } else if (job.status === "failed") {
                          clearInterval(poll);
                          setAuditing(false);
                        }
                      }
                    }, 2000);
                  }
                } catch { setAuditing(false); }
              }}
              disabled={auditing}
              className="rounded-md bg-violet-500 px-4 py-2 text-sm font-medium text-white hover:bg-violet-600 disabled:opacity-50"
            >
              {auditing ? "Auditing..." : "Audit Macros"}
            </button>
          </div>

          {auditing && (
            <div className="py-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  {auditProgress.total > 0
                    ? `Reviewing macro ${auditProgress.completed}/${auditProgress.total}...`
                    : "Starting audit..."}
                </span>
                {auditProgress.total > 0 && (
                  <span className="text-xs text-zinc-500">{Math.round((auditProgress.completed / auditProgress.total) * 100)}%</span>
                )}
              </div>
              <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-violet-500 transition-all duration-500"
                  style={{ width: auditProgress.total > 0 ? `${Math.max(2, (auditProgress.completed / auditProgress.total) * 100)}%` : "2%" }}
                />
              </div>
            </div>
          )}

          {auditResults && auditResults.length > 0 && (
            <div>
              {/* Summary */}
              <div className="mb-4 flex gap-4 text-xs text-zinc-500">
                <span>{auditResults.length} macros audited</span>
                <span>{auditResults.filter(a => a.has_changes).length} need changes</span>
                <span>{auditResults.filter(a => a.accuracy_issues.length > 0).length} have accuracy issues</span>
                <span className="text-green-600">{auditApplied.size} applied</span>
              </div>

              {/* Apply all button */}
              {auditResults.filter(a => a.has_changes).length > 0 && (
                <div className="mb-4">
                  <button
                    onClick={async () => {
                      setAuditApplying(true);
                      const updates = auditResults
                        .filter(a => a.has_changes && !auditApplied.has(a.macro_id))
                        .map(a => ({ macro_id: a.macro_id, body_text: a.rewritten, body_html: a.rewritten_html }));
                      const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}/audit-macros`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ updates }),
                      });
                      if (res.ok) {
                        setAuditApplied(new Set(updates.map(u => u.macro_id)));
                      }
                      setAuditApplying(false);
                    }}
                    disabled={auditApplying || auditApplied.size >= auditResults.filter(a => a.has_changes).length}
                    className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
                  >
                    {auditApplying ? "Applying..." : `Apply All ${auditResults.filter(a => a.has_changes).length - auditApplied.size} Changes`}
                  </button>
                </div>
              )}

              {/* Individual audits */}
              <div className="space-y-3">
                {auditResults.map(a => (
                  <div key={a.macro_id} className={`rounded-lg border p-4 ${
                    a.accuracy_issues.length > 0 ? "border-red-200 dark:border-red-800" :
                    a.has_changes ? "border-amber-200 dark:border-amber-800" :
                    "border-zinc-200 dark:border-zinc-700"
                  }`}>
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{a.macro_name}</span>
                        <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">{a.category}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {a.issues_detected.map((issue, i) => (
                          <span key={i} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900 dark:text-amber-300">{issue}</span>
                        ))}
                        {!a.has_changes && <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-900 dark:text-green-300">OK</span>}
                        {auditApplied.has(a.macro_id) && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Applied</span>}
                      </div>
                    </div>

                    {a.has_changes && (
                      <div className="grid gap-3 sm:grid-cols-2 mb-2">
                        <div>
                          <div className="text-[10px] font-medium text-red-400 uppercase tracking-wider mb-0.5">Before</div>
                          <div className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-800 dark:bg-red-950 dark:text-red-200 whitespace-pre-wrap max-h-40 overflow-y-auto">{a.original}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-medium text-emerald-400 uppercase tracking-wider mb-0.5">After</div>
                          <div className="rounded bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 max-h-40 overflow-y-auto prose prose-sm max-w-none [&_a]:text-indigo-600 [&_a]:underline dark:[&_a]:text-indigo-400 [&_p]:mb-2 [&_p]:last:mb-0"
                            dangerouslySetInnerHTML={{ __html: a.rewritten_html || a.rewritten.replace(/\n/g, "<br>") }} />
                        </div>
                      </div>
                    )}

                    {a.changes.length > 0 && (
                      <div className="text-[10px] text-zinc-500 mb-1">
                        Changes: {a.changes.join(" · ")}
                      </div>
                    )}
                    {a.accuracy_issues.length > 0 && (
                      <div className="text-[10px] text-red-500">
                        Accuracy: {a.accuracy_issues.join(" · ")}
                      </div>
                    )}

                    {a.has_changes && !auditApplied.has(a.macro_id) && (
                      <button
                        onClick={async () => {
                          const res = await fetch(`/api/workspaces/${workspace.id}/product-intelligence/${piId}/audit-macros`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ updates: [{ macro_id: a.macro_id, body_text: a.rewritten, body_html: a.rewritten_html }] }),
                          });
                          if (res.ok) setAuditApplied(prev => new Set([...prev, a.macro_id]));
                        }}
                        className="mt-2 rounded bg-emerald-500 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
                      >
                        Apply
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
