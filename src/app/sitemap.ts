import type { MetadataRoute } from "next";
import { listPublishedProducts } from "@/app/(storefront)/_lib/page-data";

/**
 * Dynamic sitemap. Lists every published storefront product at its
 * /store/{workspace}/{slug} path. Custom-domain variants are not
 * emitted here — Vercel serves the same content under both URLs, and
 * each custom domain hosts its own canonical sitemap at /sitemap.xml.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  const products = await listPublishedProducts().catch(() => []);

  return products.map((p) => ({
    url: `${base}/store/${p.workspace}/${p.slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: 0.8,
  }));
}
