import { notFound } from "next/navigation";
import { cacheLife } from "next/cache";
import type { Metadata } from "next";

import {
  getBlogWorkspaceBySlug,
  getBlogPost,
  listRelatedPosts,
  listBlogPostParams,
  listBlogTopics,
  groupingLabel,
} from "../../../../_lib/blog-data";
import { storefrontFont } from "../../../../_lib/fonts";
import { storefrontThemeStyle } from "../../../../_lib/storefront-theme";
import { BlogHeader } from "../../../../_components/BlogHeader";
import { BlogPostCard } from "../../../../_components/BlogPostCard";
import { BlogPostJsonLd } from "../../../../_components/BlogJsonLd";
import { StorefrontFooter } from "../../../../_components/StorefrontFooter";
import { getAuthor } from "@/lib/blog/authors";

/** Defer below-the-fold article images so a slow connection isn't blocked on
 *  ~1MB of imagery up front. The featured/hero image stays eager (it's the LCP).
 *  Adds loading=lazy + decoding=async to every <img> in the post body. */
function lazyifyHtml(html: string): string {
  return (html || "").replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy" decoding="async" ');
}

/**
 * Storefront blog post — /blog/{handle}.
 *
 * PDP-style chrome (workspace logo header + branded footer) wrapped around
 * the imported article HTML. content_html images already point at our
 * storage (migrated off Shopify during import), so it renders directly.
 *
 * SSG'd per (workspace, handle); reachable publicly at /blog/{handle} via
 * the middleware rewrite, and at /store/{ws}/blog/{handle} (noindex) for
 * admin preview.
 */
export const dynamicParams = true;

const MAIN_SITE = "https://superfoodscompany.com";

export async function generateStaticParams() {
  return listBlogPostParams();
}

function postUrls(domain: string | null, workspace: string, handle: string) {
  const blogUrl = domain ? `https://${domain}/blog` : `/store/${workspace}/blog`;
  return { blogUrl, postUrl: `${blogUrl}/${handle}` };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string; handle: string }>;
}): Promise<Metadata> {
  const { workspace, handle } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) return { title: "Not Found" };
  const post = await getBlogPost(ws.id, handle);
  if (!post) return { title: "Not Found" };

  const title = post.seo_title || `${post.title} — ${ws.name}`;
  const description =
    post.seo_description ||
    post.excerpt ||
    (post.content_text || "").slice(0, 200);
  const { postUrl } = postUrls(ws.storefront_domain, workspace, handle);
  const favicon = ws.design.favicon_url || ws.design.logo_url || null;
  const image = post.featured_image_url || undefined;

  return {
    title,
    description,
    alternates: { canonical: postUrl },
    icons: favicon ? { icon: favicon, apple: favicon } : undefined,
    keywords: post.tags?.length ? post.tags : undefined,
    openGraph: {
      type: "article",
      title,
      description,
      url: postUrl,
      siteName: ws.name,
      publishedTime: post.published_at || undefined,
      modifiedTime: post.updated_at || post.published_at || undefined,
      tags: post.tags?.length ? post.tags : undefined,
      images: image ? [{ url: image }] : undefined,
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ workspace: string; handle: string }>;
}) {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });

  const { workspace, handle } = await params;
  const ws = await getBlogWorkspaceBySlug(workspace);
  if (!ws) notFound();
  const post = await getBlogPost(ws.id, handle);
  if (!post) notFound();

  const related = await listRelatedPosts(ws.id, post, 3);
  const topics = await listBlogTopics(ws.id);

  const font = storefrontFont(ws.design.font_key);
  const themeStyle = storefrontThemeStyle(ws.design, font.stack);
  const { blogUrl, postUrl } = postUrls(ws.storefront_domain, workspace, handle);
  const label = groupingLabel(post.grouping);
  const dateLabel = formatDate(post.published_at);
  const author = getAuthor(post.author_slug);

  return (
    <div className={font.className} style={themeStyle}>
      <BlogPostJsonLd
        brand={ws.name}
        logoUrl={ws.design.logo_url}
        blogUrl={blogUrl}
        postUrl={postUrl}
        post={post}
        author={author}
      />

      <BlogHeader
        workspaceName={ws.name}
        logoUrl={ws.design.logo_url}
        topics={topics}
        shopUrl={MAIN_SITE}
      />

      <main className="flex w-full flex-col">
        <article className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6 md:py-14">
          {/* Breadcrumb — matches the BreadcrumbList JSON-LD */}
          <nav aria-label="Breadcrumb" className="mb-6 text-sm text-zinc-500">
            <a href="/blog" className="hover:text-zinc-900">Blog</a>
            <span className="mx-2">/</span>
            <span className="text-zinc-700">{post.title}</span>
          </nav>

          <header className="mb-8">
            {label && (
              <a
                href={`/blog?topic=${encodeURIComponent(post.grouping || "")}`}
                className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide"
                style={{
                  color: "var(--storefront-accent)",
                  backgroundColor:
                    "color-mix(in srgb, var(--storefront-accent) 12%, white)",
                }}
              >
                {label}
              </a>
            )}
            <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-zinc-900 md:text-4xl">
              {post.title}
            </h1>
            {/* Byline — named author with photo + bio (E-E-A-T human signal). */}
            {author ? (
              <div className="mt-6 flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={author.avatarUrl}
                  alt={author.name}
                  width={44}
                  height={44}
                  loading="lazy"
                  className="h-11 w-11 rounded-full object-cover"
                />
                <div className="text-sm leading-tight">
                  <div className="font-semibold text-zinc-900">{author.name}</div>
                  <div className="text-zinc-500">
                    {author.role}
                    {dateLabel && <> · <time dateTime={post.published_at || undefined}>{dateLabel}</time></>}
                  </div>
                </div>
              </div>
            ) : (
              dateLabel && (
                <p className="mt-4 text-sm text-zinc-500">
                  <time dateTime={post.published_at || undefined}>{dateLabel}</time>
                </p>
              )
            )}
          </header>

          {post.featured_image_url && (
            <div className="mb-10 overflow-hidden rounded-2xl bg-zinc-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={post.featured_image_url}
                alt={post.title}
                // The hero is the LCP element — load it eagerly + high priority,
                // unlike the lazy in-body images below.
                fetchPriority="high"
                className="h-auto w-full object-cover"
              />
            </div>
          )}

          {/* Article body — stored HTML; in-body images deferred (lazyifyHtml). */}
          <div
            className="prose prose-zinc max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-a:font-medium prose-a:text-emerald-700 prose-a:no-underline hover:prose-a:underline prose-img:rounded-xl prose-img:mx-auto"
            style={{ ["--tw-prose-links" as string]: "var(--storefront-accent)" }}
            dangerouslySetInnerHTML={{ __html: lazyifyHtml(post.content_html || "") }}
          />

          {/* Author bio card — reinforces real human authorship. */}
          {author && (
            <div className="mt-12 flex items-start gap-4 rounded-2xl border border-zinc-200 bg-white p-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={author.avatarUrl}
                alt={author.name}
                width={56}
                height={56}
                loading="lazy"
                className="h-14 w-14 shrink-0 rounded-full object-cover"
              />
              <div>
                <div className="text-sm font-semibold text-zinc-900">{author.name}</div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{author.role}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{author.bio}</p>
              </div>
            </div>
          )}

          {/* Shop CTA — convert content readers into the funnel. */}
          <div className="mt-12 rounded-2xl border border-zinc-200 bg-zinc-50 p-6 text-center">
            <p className="text-base font-semibold text-zinc-900">
              Ready to try it for yourself?
            </p>
            <a
              href={MAIN_SITE}
              className="mt-4 inline-flex items-center justify-center rounded-full px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
              style={{ backgroundColor: "var(--storefront-accent)" }}
            >
              Shop {ws.name}
            </a>
          </div>
        </article>

        {related.length > 0 && (
          <section className="border-t border-zinc-100 bg-zinc-50/60">
            <div className="mx-auto w-full max-w-6xl px-4 py-12 md:px-8">
              <h2 className="mb-6 text-xl font-bold tracking-tight text-zinc-900">
                Keep reading
              </h2>
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {related.map((p) => (
                  <BlogPostCard key={p.id} post={p} />
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <StorefrontFooter
        workspaceName={ws.name || "Superfoods Company"}
        supportEmail={ws.support_email}
      />
    </div>
  );
}
