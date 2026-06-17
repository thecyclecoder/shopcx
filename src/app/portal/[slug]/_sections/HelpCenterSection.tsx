"use client";

/**
 * Help Center section — surfaces the workspace's published KB articles
 * (the same ones on the help mini-site) inside the portal, without leaving.
 *
 * Browse model: a grid of **product cards** (image + name) → click a product to
 * see its articles, plus a **General** card for articles with no product. Search
 * flattens across everything. Reuses the public help APIs (anonymous, same-origin):
 *   - list:   GET /api/help/{helpSlug}[?search=]        (articles + products[])
 *   - reader: GET /api/widget/{workspaceId}/articles/{id}   (content_html)
 */
import { useEffect, useRef, useState } from "react";

interface KbArticle {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  excerpt: string | null;
  product_id?: string | null;
  product_name?: string | null;
}
interface KbProduct {
  id: string;
  title: string;
  image_url: string | null;
}

const GENERAL = "__general__";

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
  const [products, setProducts] = useState<KbProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KbArticle[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // product id | GENERAL | null (grid)
  const [openId, setOpenId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Full load — drives the product grid + per-product article lists.
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/help/${encodeURIComponent(helpSlug)}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.articles)) setArticles(data.articles);
        if (Array.isArray(data.products)) setProducts(data.products);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [helpSlug]);

  // Debounced server-side search (title + content ilike) — flat results.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) { setSearchResults(null); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/help/${encodeURIComponent(helpSlug)}?search=${encodeURIComponent(query.trim())}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        setSearchResults(Array.isArray(data.articles) ? data.articles : []);
      } catch { setSearchResults([]); }
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, helpSlug]);

  if (openId) {
    return <ArticleReader id={openId} workspaceId={workspaceId} onBack={() => setOpenId(null)} primaryColor={primaryColor} />;
  }

  // Bucket articles by product.
  const byProduct = new Map<string, KbArticle[]>();
  const general: KbArticle[] = [];
  for (const a of articles) {
    if (a.product_id) {
      if (!byProduct.has(a.product_id)) byProduct.set(a.product_id, []);
      byProduct.get(a.product_id)!.push(a);
    } else {
      general.push(a);
    }
  }
  // Only products that actually have published articles, in the API's order.
  const productCards = products.filter((p) => (byProduct.get(p.id)?.length ?? 0) > 0);

  const searchBar = (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6">
      <h2 className="text-lg font-semibold text-zinc-900">Help Center</h2>
      <p className="mt-1 text-sm text-zinc-500">Find answers by product, or search across everything.</p>
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
  );

  // ── Search mode — flat results across all articles ──
  if (searchResults !== null) {
    return (
      <div className="space-y-6">
        {searchBar}
        {searchResults.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No articles match &ldquo;{query}&rdquo;.</div>
        ) : (
          <ArticleList articles={searchResults} onOpen={setOpenId} />
        )}
      </div>
    );
  }

  // ── Drill-in — one product's (or general) articles ──
  if (selected) {
    const list = selected === GENERAL ? general : (byProduct.get(selected) ?? []);
    const title = selected === GENERAL ? "General" : (products.find((p) => p.id === selected)?.title ?? "Articles");
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setSelected(null)} className="flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-800">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
          All topics
        </button>
        <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
        <ArticleList articles={list} onOpen={setOpenId} />
      </div>
    );
  }

  // ── Browse grid — product cards + General ──
  return (
    <div className="space-y-6">
      {searchBar}
      {loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : productCards.length === 0 && general.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No help articles yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {productCards.map((p) => (
            <TopicCard
              key={p.id}
              title={p.title}
              imageUrl={p.image_url}
              count={byProduct.get(p.id)!.length}
              onClick={() => setSelected(p.id)}
            />
          ))}
          {general.length > 0 && (
            <TopicCard
              title="General"
              imageUrl={null}
              count={general.length}
              onClick={() => setSelected(GENERAL)}
              primaryColor={primaryColor}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** A clickable product (or General) tile: image + name + article count. */
function TopicCard({
  title,
  imageUrl,
  count,
  onClick,
  primaryColor,
}: {
  title: string;
  imageUrl: string | null;
  count: number;
  onClick: () => void;
  primaryColor?: string;
}) {
  return (
    <button type="button" onClick={onClick} className="group flex items-center gap-4 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 text-left transition hover:border-zinc-300 hover:shadow-sm">
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={title} className="h-16 w-16 flex-shrink-0 rounded-xl object-cover" />
      ) : (
        <span
          className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-xl"
          style={{ background: "linear-gradient(135deg, #e8f3ee, #d3ebdf)", color: primaryColor || "#006540" }}
        >
          <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-zinc-900 group-hover:text-zinc-700">{title}</span>
        <span className="mt-0.5 block text-xs text-zinc-500">{count} {count === 1 ? "article" : "articles"}</span>
      </span>
      <svg className="h-4 w-4 flex-shrink-0 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
    </button>
  );
}

/** A flat, scannable list of article rows. */
function ArticleList({ articles, onOpen }: { articles: KbArticle[]; onOpen: (id: string) => void }) {
  if (articles.length === 0) {
    return <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No articles here yet.</div>;
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      {articles.map((a, i) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onOpen(a.id)}
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
        Back
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
