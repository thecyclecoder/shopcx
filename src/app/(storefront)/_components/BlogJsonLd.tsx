import type { BlogPostCard, BlogPostFull } from "../_lib/blog-data";

/**
 * Schema.org structured data for the blog. Rich, crawler- and LLM-friendly
 * markup so search engines render article snippets and assistants can cite
 * the content with attribution.
 *
 *   - Index → `Blog` + `ItemList` of every post (BlogPosting entries).
 *   - Post  → `BlogPosting` (headline, image, dates, author, publisher,
 *             articleBody) + a `BreadcrumbList` (Home › Blog › Article).
 *
 * All values are admin/import-sourced strings; JSON.stringify is safe.
 */

function publisherLd(brand: string, logoUrl: string | null) {
  return {
    "@type": "Organization",
    name: brand,
    ...(logoUrl ? { logo: { "@type": "ImageObject", url: logoUrl } } : {}),
  };
}

export function BlogIndexJsonLd({
  brand,
  logoUrl,
  blogUrl,
  posts,
}: {
  brand: string;
  logoUrl: string | null;
  blogUrl: string;
  posts: BlogPostCard[];
}) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `${brand} Blog`,
    url: blogUrl,
    publisher: publisherLd(brand, logoUrl),
    blogPost: posts.slice(0, 50).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      url: `${blogUrl}/${p.handle}`,
      ...(p.excerpt ? { description: p.excerpt } : {}),
      ...(p.featured_image_url ? { image: [p.featured_image_url] } : {}),
      ...(p.published_at ? { datePublished: p.published_at } : {}),
    })),
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
    />
  );
}

export function BlogPostJsonLd({
  brand,
  logoUrl,
  blogUrl,
  postUrl,
  post,
}: {
  brand: string;
  logoUrl: string | null;
  blogUrl: string;
  postUrl: string;
  post: BlogPostFull;
}) {
  const article: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    mainEntityOfPage: { "@type": "WebPage", "@id": postUrl },
    url: postUrl,
    author: { "@type": "Organization", name: brand },
    publisher: publisherLd(brand, logoUrl),
  };
  if (post.seo_description || post.excerpt) {
    article.description = post.seo_description || post.excerpt;
  }
  if (post.featured_image_url) article.image = [post.featured_image_url];
  if (post.published_at) article.datePublished = post.published_at;
  article.dateModified = post.updated_at || post.published_at || undefined;
  if (post.tags?.length) article.keywords = post.tags.join(", ");
  if (post.content_text) article.articleBody = post.content_text.slice(0, 5000);

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Blog", item: blogUrl },
      { "@type": "ListItem", position: 2, name: post.title, item: postUrl },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(article) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
    </>
  );
}
