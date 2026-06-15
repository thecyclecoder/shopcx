import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getPageData, listPublishedProducts } from "../../../_lib/page-data";
import { StorefrontPage } from "../../../_lib/render-page";
import { loadAdvertorialContent, type AdvertorialVariant } from "@/lib/advertorial-pages";

/**
 * The single storefront route.
 *
 * Two external URL shapes both render this page:
 *   1. Admin preview:     shopcx.ai/store/{workspace}/{slug}
 *   2. Public storefront: {custom-domain}/{slug}
 *      — middleware rewrites to /store/{workspace}/{slug} internally
 *        so both hit this same SSG'd HTML.
 *
 * Crucially, this route does NOT read headers() or cookies(), so
 * Next.js can statically generate every (workspace, slug) pair via
 * generateStaticParams and serve from Vercel's edge CDN with sub-100ms
 * TTFB. Robots/indexing differs between the two hosts: middleware sets
 * X-Robots-Tag: noindex on shopcx.ai requests so the preview URL
 * doesn't compete with the customer-facing canonical.
 */
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateStaticParams() {
  return listPublishedProducts();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>;
}): Promise<Metadata> {
  const { workspace, slug } = await params;
  const data = await getPageData(workspace, slug);
  if (!data) return { title: "Not Found" };

  const title = data.page_content?.hero_headline || data.product.title;
  const description =
    data.page_content?.hero_subheadline ||
    (data.product.description || "").replace(/<[^>]*>/g, "").slice(0, 200);

  // Canonical always points to the customer-facing URL on the custom
  // domain — never the shopcx.ai preview URL. Middleware injects
  // X-Robots-Tag: noindex on preview requests to make this stick.
  const canonicalDomain = data.workspace.storefront_domain;
  const canonical = canonicalDomain
    ? `https://${canonicalDomain}/${slug}`
    : `/store/${workspace}/${slug}`;

  // Favicon: workspace-specific so a Superfoods customer never sees the
  // ShopCX logo in their tab. Falls back to the workspace logo, then to
  // the root /favicon.ico.
  const faviconUrl = data.workspace.design.favicon_url || data.workspace.design.logo_url || null;

  return {
    title,
    description,
    alternates: { canonical },
    icons: faviconUrl ? { icon: faviconUrl, apple: faviconUrl } : undefined,
    openGraph: {
      type: "website",
      title,
      description,
      url: canonical,
      images: data.product.image_url ? [{ url: data.product.image_url }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: data.product.image_url ? [data.product.image_url] : undefined,
    },
  };
}

export default async function StorefrontProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; slug: string }>;
  // Ad-matched lander modes. Reading searchParams keeps the param-less PDP
  // statically generated (generateStaticParams) and only renders these requests
  // dynamically — and the route still reads no headers/cookies, so it's ISR-safe.
  searchParams: Promise<{ variant?: string; angle?: string }>;
}) {
  const { workspace, slug } = await params;
  const sp = await searchParams;
  const data = await getPageData(workspace, slug);
  if (!data) notFound();

  const variant: AdvertorialVariant | null =
    sp.variant === "advertorial" || sp.variant === "beforeafter" ? sp.variant : null;
  const advertorial = variant ? await loadAdvertorialContent(data, variant, sp.angle ?? null) : null;

  const canonical = data.workspace.storefront_domain
    ? `https://${data.workspace.storefront_domain}/${slug}`
    : `/store/${workspace}/${slug}`;

  return (
    <StorefrontPage
      data={data}
      canonicalPath={canonical}
      reviewSlug={slug}
      advertorial={advertorial}
    />
  );
}
