import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { createAdminClient } from "@/lib/supabase/admin";
import { getBlogWorkspaceBySlug, listBlogPosts } from "../../../_lib/blog-data";
import { storefrontFont } from "../../../_lib/fonts";
import { storefrontThemeStyle } from "../../../_lib/storefront-theme";

/**
 * "Link in bio" page — /links.
 *
 * The Instagram Graph API cannot set a profile's bio link, so the durable
 * pattern is a stable URL we control. Set the IG/FB bio link to {domain}/links
 * ONCE; this page then always reflects the latest blog posts + the products
 * they reference, so every "link in bio" CTA the social scheduler writes resolves
 * to current content automatically — no per-post bio edit, no API.
 *
 * Mobile-first (bio-link traffic is ~all mobile). SSG with a short revalidate so
 * a freshly published post shows up quickly.
 */
export const revalidate = 600;
export const dynamicParams = true;

const MAIN_SITE = "https://superfoodscompany.com";
const RECENT_POST_COUNT = 6;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<Metadata> {
  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) return { title: "Not Found" };
  const favicon = ws.design.favicon_url || ws.design.logo_url || null;
  return {
    title: `${ws.name} — Links`,
    description: `The latest from ${ws.name}: recipes, guides, and the products we love.`,
    icons: favicon ? { icon: favicon, apple: favicon } : undefined,
    // Utility page — keep it out of the index so it doesn't compete with real content.
    robots: { index: false, follow: true },
  };
}

interface ProductLink {
  handle: string;
  title: string;
  image_url: string | null;
}

export default async function LinksPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) notFound();

  const posts = (await listBlogPosts(ws.id)).slice(0, RECENT_POST_COUNT);

  // Products referenced by these recent posts (deduped, in post order) → PDP links.
  const admin = createAdminClient();
  const products: ProductLink[] = [];
  if (posts.length) {
    const { data: links } = await admin
      .from("post_products")
      .select("post_id, product_id")
      .in("post_id", posts.map((p) => p.id));
    const orderedProductIds: string[] = [];
    const seen = new Set<string>();
    for (const p of posts) {
      for (const l of links || []) {
        if (l.post_id === p.id && !seen.has(l.product_id)) {
          seen.add(l.product_id);
          orderedProductIds.push(l.product_id);
        }
      }
    }
    if (orderedProductIds.length) {
      const { data: prods } = await admin
        .from("products")
        .select("id, handle, title, image_url")
        .in("id", orderedProductIds);
      const byId = new Map((prods || []).map((p) => [p.id, p]));
      for (const id of orderedProductIds.slice(0, 4)) {
        const p = byId.get(id);
        if (p?.handle) products.push({ handle: p.handle, title: p.title, image_url: p.image_url });
      }
    }
  }

  const font = storefrontFont(ws.design.font_key);
  const themeStyle = storefrontThemeStyle(ws.design, font.stack);

  return (
    <div
      className={`${font.className} min-h-screen`}
      style={{
        ...themeStyle,
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--storefront-accent) 10%, white) 0%, white 40%)",
      }}
    >
      <main className="mx-auto flex w-full max-w-md flex-col items-center px-5 py-10">
        {/* Brand */}
        <a href={MAIN_SITE} className="flex flex-col items-center">
          {ws.design.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={ws.design.logo_url} alt={ws.name} className="h-12 w-auto" fetchPriority="high" />
          ) : (
            <span className="text-xl font-extrabold text-zinc-900" style={{ fontFamily: "var(--storefront-heading-font)" }}>
              {ws.name}
            </span>
          )}
        </a>
        <p className="mt-3 text-center text-sm text-zinc-500">
          Recipes, guides, and the products we love.
        </p>

        {/* Latest posts */}
        {posts.length > 0 && (
          <section className="mt-8 w-full">
            <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Latest from the blog
            </h2>
            <div className="flex flex-col gap-3">
              {posts.map((p) => (
                <a
                  key={p.id}
                  href={`/blog/${p.handle}`}
                  className="flex items-center gap-3 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm transition active:scale-[0.99]"
                >
                  {p.featured_image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.featured_image_url}
                      alt=""
                      loading="lazy"
                      className="h-14 w-14 shrink-0 rounded-xl object-cover"
                    />
                  )}
                  <span className="line-clamp-2 text-sm font-semibold text-zinc-900">{p.title}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Shop the products */}
        {products.length > 0 && (
          <section className="mt-8 w-full">
            <h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Shop</h2>
            <div className="flex flex-col gap-3">
              {products.map((p) => (
                <a
                  key={p.handle}
                  href={`/${p.handle}`}
                  className="flex items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-sm font-semibold text-white shadow-sm transition active:scale-[0.99]"
                  style={{ backgroundColor: "var(--storefront-accent)" }}
                >
                  <span>Shop {p.title}</span>
                  <svg className="h-4 w-4 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                </a>
              ))}
            </div>
          </section>
        )}

        <a href="/blog" className="mt-8 text-sm font-semibold text-zinc-500 underline-offset-2 hover:underline">
          See all articles →
        </a>
      </main>
    </div>
  );
}
