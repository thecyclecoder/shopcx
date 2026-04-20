import { notFound } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";

import { getPageData, listPublishedProducts } from "../_lib/page-data";
import { StorefrontPage } from "../_lib/render-page";

export const revalidate = 3600;
export const dynamicParams = true;

/**
 * Public storefront — customer-facing, indexable, served on custom
 * domains. The path only has {slug}; workspace is determined by the
 * middleware via `x-storefront-workspace-slug` (set on custom-domain
 * rewrites).
 */
export async function generateStaticParams() {
  // At build time we don't know which custom domains map to which
  // workspaces. Enumerate every published handle across every workspace
  // — Next.js will SSG one page per unique handle. Workspace resolution
  // at request time picks the right one.
  const all = await listPublishedProducts();
  const seen = new Set<string>();
  const uniq: Array<{ slug: string }> = [];
  for (const { slug } of all) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    uniq.push({ slug });
  }
  return uniq;
}

async function resolveWorkspaceSlug(): Promise<string | null> {
  const h = await headers();
  return h.get("x-storefront-workspace-slug");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const workspaceSlug = await resolveWorkspaceSlug();
  if (!workspaceSlug) return { title: "Not Found" };

  const data = await getPageData(workspaceSlug, slug);
  if (!data) return { title: "Not Found" };

  const title = data.page_content?.hero_headline || data.product.title;
  const description =
    data.page_content?.hero_subheadline ||
    (data.product.description || "").replace(/<[^>]*>/g, "").slice(0, 200);

  return {
    title,
    description,
    alternates: { canonical: `/${slug}` },
    openGraph: {
      type: "website",
      title,
      description,
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

export default async function PublicStorefrontPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const workspaceSlug = await resolveWorkspaceSlug();
  if (!workspaceSlug) notFound();

  const data = await getPageData(workspaceSlug, slug);
  if (!data) notFound();

  return <StorefrontPage data={data} canonicalPath={`/${slug}`} reviewSlug={slug} />;
}
