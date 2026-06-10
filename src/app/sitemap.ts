import type { MetadataRoute } from "next";
import { listPublishedProducts } from "@/app/(storefront)/_lib/page-data";
import {
  listBlogPostParams,
  listBlogWorkspaceParams,
} from "@/app/(storefront)/_lib/blog-data";

/**
 * Dynamic sitemap. Lists every published storefront product at its
 * /store/{workspace}/{slug} path, plus the blog index + every published
 * post at /store/{workspace}/blog[/handle]. Custom-domain variants are not
 * emitted here — Vercel serves the same content under both URLs, and each
 * custom domain hosts its own canonical sitemap at /sitemap.xml.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const [products, blogWorkspaces, blogPosts] = await Promise.all([
    listPublishedProducts().catch(() => []),
    listBlogWorkspaceParams().catch(() => []),
    listBlogPostParams().catch(() => []),
  ]);

  const now = new Date();

  const productEntries: MetadataRoute.Sitemap = products.map((p) => ({
    url: `${base}/store/${p.workspace}/${p.slug}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));

  const blogIndexEntries: MetadataRoute.Sitemap = blogWorkspaces.map((w) => ({
    url: `${base}/store/${w.workspace}/blog`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  const blogPostEntries: MetadataRoute.Sitemap = blogPosts.map((p) => ({
    url: `${base}/store/${p.workspace}/blog/${p.handle}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.6,
  }));

  return [...productEntries, ...blogIndexEntries, ...blogPostEntries];
}
