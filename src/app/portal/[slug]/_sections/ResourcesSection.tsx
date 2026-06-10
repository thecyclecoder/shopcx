"use client";

/**
 * Resources section — product guides imported from the blog (spec:
 * blog-resources). Fetches /api/portal?route=resources: the customer's
 * owned products, grouped product → grouping (Recipes / How it works /
 * How to use / The science). A search bar queries ALL published resources
 * (discovery). Clicking a card opens the reader (content_html).
 */
import { useEffect, useRef, useState } from "react";

interface ResourcePost {
  id: string;
  title: string;
  excerpt: string | null;
  featured_image_url: string | null;
  handle: string | null;
  grouping?: string | null;
}
interface ProductGroup {
  id: string;
  title: string;
  groupings: { grouping: string; label: string; posts: ResourcePost[] }[];
}

export function ResourcesSection({ primaryColor }: { primaryColor: string }) {
  const [products, setProducts] = useState<ProductGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ResourcePost[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/portal?route=resources", { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.products)) setProducts(data.products);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  // Debounced search across all resources.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) { setSearchResults(null); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/portal?route=resources&q=${encodeURIComponent(query.trim())}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        setSearchResults(Array.isArray(data.results) ? data.results : []);
      } catch { setSearchResults([]); }
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query]);

  if (openId) return <ResourceReader id={openId} onBack={() => setOpenId(null)} primaryColor={primaryColor} />;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-900">Resources</h2>
        <p className="mt-1 text-sm text-zinc-500">Recipes, how-to guides, and the science behind the products you love.</p>
        <div className="relative mt-4">
          <svg className="absolute left-3 top-2.5 h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search recipes, guides, studies…"
            className="w-full rounded-lg border border-zinc-300 bg-white py-2.5 pl-10 pr-3 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Search results */}
      {searchResults !== null ? (
        searchResults.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">No resources match &ldquo;{query}&rdquo;.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {searchResults.map((p) => <PostCard key={p.id} post={p} onOpen={() => setOpenId(p.id)} />)}
          </div>
        )
      ) : loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : products.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-600">
          No resources for your products yet — try searching above.
        </div>
      ) : (
        products.map((prod) => (
          <section key={prod.id} className="space-y-3">
            <h3 className="text-base font-semibold text-zinc-900">{prod.title}</h3>
            {prod.groupings.map((g) => (
              <div key={g.grouping}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">{g.label}</div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {g.posts.map((p) => <PostCard key={p.id} post={p} onOpen={() => setOpenId(p.id)} />)}
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function PostCard({ post, onOpen }: { post: ResourcePost; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group block overflow-hidden rounded-2xl border border-zinc-200 bg-white text-left transition hover:border-zinc-300">
      {post.featured_image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={post.featured_image_url} alt={post.title} className="h-36 w-full object-cover" />
      )}
      <div className="p-4">
        <h4 className="text-sm font-semibold text-zinc-900 group-hover:text-zinc-700">{post.title}</h4>
        {post.excerpt && <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{post.excerpt}</p>}
      </div>
    </button>
  );
}

function ResourceReader({ id, onBack, primaryColor }: { id: string; onBack: () => void; primaryColor: string }) {
  const [post, setPost] = useState<{ title: string; content_html: string; featured_image_url: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/portal?route=resourcePost&id=${encodeURIComponent(id)}`, { credentials: "same-origin" });
        const data = await res.json().catch(() => ({}));
        if (data.post) setPost(data.post);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [id]);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-800">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
        Back to resources
      </button>
      {loading ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading…</div>
      ) : !post ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Resource not found.</div>
      ) : (
        <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
          {post.featured_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.featured_image_url} alt={post.title} className="h-56 w-full object-cover" />
          )}
          <div className="p-5 sm:p-7">
            <h1 className="text-xl font-bold text-zinc-900" style={{ borderColor: primaryColor }}>{post.title}</h1>
            <div
              className="prose prose-sm mt-4 max-w-none text-zinc-800 [&_a]:text-emerald-700 [&_img]:rounded-lg [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold"
              dangerouslySetInnerHTML={{ __html: post.content_html || "" }}
            />
          </div>
        </article>
      )}
    </div>
  );
}
