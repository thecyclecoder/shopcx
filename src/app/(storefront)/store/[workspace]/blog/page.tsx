import { notFound } from "next/navigation";
import { cacheLife } from "next/cache";
import type { Metadata } from "next";

import {
  getBlogWorkspaceBySlug,
  listBlogPosts,
  listBlogWorkspaceParams,
  BLOG_GROUPINGS,
} from "../../../_lib/blog-data";
import { storefrontFont } from "../../../_lib/fonts";
import { storefrontThemeStyle } from "../../../_lib/storefront-theme";
import { BlogHeader } from "../../../_components/BlogHeader";
import { BlogIndexGrid } from "../../../_components/BlogIndexGrid";
import { BlogIndexJsonLd } from "../../../_components/BlogJsonLd";
import { BlogPixelInit } from "../../../_components/BlogPixelInit";
import { StorefrontFooter } from "../../../_components/StorefrontFooter";

/**
 * Storefront blog index — /blog.
 *
 * Same static-delivery model as the PDP: no headers()/cookies(), so Next
 * SSGs every (workspace) and Vercel serves from the edge. Two URL shapes
 * resolve here:
 *   1. Public:  {custom-domain}/blog        (middleware rewrite)
 *   2. Preview: shopcx.ai/store/{ws}/blog    (noindex via middleware)
 *
 * The page renders every published post into the initial HTML (crawler +
 * LLM friendly); the header topic tabs filter client-side via ?topic=.
 */

const MAIN_SITE = "https://superfoodscompany.com";

export async function generateStaticParams() {
  // A flaky build-time DB query here must NOT fail the whole production build — the blog
  // pages fall back to on-demand rendering. (This was freezing every production deploy.)
  // Cache Components (Next 16) rejects an empty array with EmptyGenerateStaticParamsError,
  // so on failure/emptiness we return a single sentinel workspace slug that the page-body's
  // getBlogWorkspaceBySlug will resolve to null → notFound() at request time. Same on-demand
  // fallback behavior; satisfies Cache Components' non-empty invariant.
  try {
    const params = await listBlogWorkspaceParams();
    return params.length > 0 ? params : [{ workspace: "__none__" }];
  } catch {
    return [{ workspace: "__none__" }];
  }
}

function blogBaseUrl(domain: string | null, workspace: string): string {
  return domain ? `https://${domain}/blog` : `/store/${workspace}/blog`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string }>;
}): Promise<Metadata> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });
  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) return { title: "Not Found" };

  const title = `${ws.name} Blog — Recipes, Guides & The Science`;
  const description = `Recipes, how-to guides, and the science behind ${ws.name}. Tips and research to get the most out of every product.`;
  const canonical = blogBaseUrl(ws.storefront_domain, workspace);
  const favicon = ws.design.favicon_url || ws.design.logo_url || null;

  return {
    title,
    description,
    alternates: { canonical },
    icons: favicon ? { icon: favicon, apple: favicon } : undefined,
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      siteName: ws.name,
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });

  const { workspace } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) notFound();

  const posts = await listBlogPosts(ws.id);

  const font = storefrontFont(ws.design.font_key);
  const themeStyle = storefrontThemeStyle(ws.design, font.stack);
  const baseUrl = blogBaseUrl(ws.storefront_domain, workspace);

  // Only show topic tabs that actually have posts.
  const present = new Set(posts.map((p) => p.grouping).filter(Boolean));
  const topics = BLOG_GROUPINGS.filter((g) => present.has(g.key)).map((g) => ({
    key: g.key,
    label: g.label,
  }));

  return (
    <div className={font.className} style={themeStyle}>
      <BlogPixelInit
        workspaceId={ws.id}
        metaPixelId={ws.meta_pixel_id}
        blogHandle={null}
        title="Blog index"
      />
      <BlogIndexJsonLd
        brand={ws.name}
        logoUrl={ws.design.logo_url}
        blogUrl={baseUrl}
        posts={posts}
      />

      <BlogHeader
        workspaceName={ws.name}
        logoUrl={ws.design.logo_url}
        topics={topics}
        followTopicParam
        shopUrl={MAIN_SITE}
      />

      <main className="flex w-full flex-col">
        {/* Hero band — branded title strip, mirrors the PDP's hero rhythm. */}
        <section
          className="border-b border-zinc-100 px-4 py-12 text-center md:py-16"
          style={{
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--storefront-accent) 8%, white) 0%, white 100%)",
          }}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            {ws.name}
          </p>
          <h1 className="mx-auto mt-3 max-w-3xl text-3xl font-bold tracking-tight text-zinc-900 md:text-5xl">
            The Superfood Scoop
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-zinc-600 md:text-lg">
            Recipes, how-to guides, and the science behind the products you love.
          </p>
        </section>

        <div className="mx-auto w-full max-w-6xl px-4 py-10 md:px-8 md:py-14">
          {posts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center text-sm text-zinc-500">
              No articles published yet — check back soon.
            </div>
          ) : (
            <BlogIndexGrid posts={posts} topics={topics} />
          )}
        </div>
      </main>

      <StorefrontFooter
        workspaceName={ws.name || "Superfoods Company"}
        supportEmail={ws.support_email}
      />
    </div>
  );
}
