"use client";

/**
 * Help Center section — surfaces the workspace's published KB articles
 * (the same ones on the help mini-site) inside the portal, searchable, so
 * the customer never has to leave. Reuses the public help APIs:
 *   - list:   GET /api/help/{helpSlug}?search=     (title + excerpt + category)
 *   - reader: GET /api/widget/{workspaceId}/articles/{id}   (content_html)
 * Both are anonymous/public, served same-origin on the portal host.
 *
 * Mirrors ResourcesSection's shape (search bar + cards + inline reader) so the
 * two sections feel consistent.
 */
import { useEffect, useRef, useState } from "react";

interface KbArticle {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  excerpt: string | null;
  product_name?: string | null;
}

export function HelpCenterSection({
  helpSlug,
  workspaceId,
  primaryColor,
}: {
  helpSlug: string;
  workspaceId: string;
  primaryColor: string;
}) {
  const [articles, setArticles] = useState<KbArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load — all published articles.
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/help/${encodeURIComponent(helpSlug)}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.articles)) setArticles(data.articles);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [helpSlug]);

  // Debounced server-side search (title + content ilike).
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = query.trim() ? `?search=${encodeURIComponent(query.trim())}` : "";
        const res = await fetch(`/api/help/${encodeURIComponent(helpSlug)}${qs}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.articles)) setArticles(data.articles);
      } catch { /* ignore */ }
      setLoading(false);
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, helpSlug]);

  if (openId) {
    return <ArticleReader id={openId} workspaceId={workspaceId} onBack={() => setOpenId(null)} primaryColor={primaryColor} />;
  }

  // Group results by category for a scannable layout.
  const byCategory = new Map<string, KbArticle[]>();
  for (const a of articles) {
    const cat = a.category || "Help";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(a);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-900">Help Center</h2>
        <p className="mt-1 text-sm text-zinc-500">Answers to common questions — search or browse below.</p>
        <div className="relative mt-4">
          <svg className="absolute left-3 top-2.5 h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help articles…"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2.5 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : articles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          {query.trim() ? <>No articles match &ldquo;{query}&rdquo;.</> : "No help articles yet."}
        </div>
      ) : (
        [...byCategory.entries()].map(([cat, list]) => (
          <section key={cat} className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{cat}</h3>
            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
              {list.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setOpenId(a.id)}
                  className={"flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-zinc-50 " + (i > 0 ? "border-t border-zinc-100" : "")}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-900">{a.title}</span>
                    {a.excerpt && <span className="mt-0.5 line-clamp-1 block text-xs text-zinc-500">{a.excerpt}</span>}
                  </span>
                  <svg className="h-4 w-4 flex-shrink-0 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function ArticleReader({
  id,
  workspaceId,
  onBack,
  primaryColor,
}: {
  id: string;
  workspaceId: string;
  onBack: () => void;
  primaryColor: string;
}) {
  const [article, setArticle] = useState<{ title: string; content_html: string | null; content: string | null } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/widget/${workspaceId}/articles/${encodeURIComponent(id)}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (data && data.id) setArticle({ title: data.title, content_html: data.content_html, content: data.content });
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [id, workspaceId]);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        Back to Help Center
      </button>
      {loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : !article ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Article not found.</div>
      ) : (
        <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          <div className="p-5 sm:p-7">
            <h1 className="text-xl font-bold text-zinc-900" style={{ borderColor: primaryColor }}>{article.title}</h1>
            {article.content_html ? (
              <div
                className="prose prose-sm mt-4 max-w-none text-zinc-800 [&_a]:text-emerald-700 [&_img]:rounded-lg [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold"
                dangerouslySetInnerHTML={{ __html: article.content_html }}
              />
            ) : (
              <div className="prose prose-sm mt-4 max-w-none text-zinc-800">
                {(article.content || "").split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
