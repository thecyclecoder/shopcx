import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { getPageData } from "../../../_lib/page-data";
import { StorefrontPage } from "../../../_lib/render-page";

/**
 * Admin preview route — shopcx.ai/store/{workspace}/{slug}.
 *
 * This renders the same page as the public route but the URL carries
 * the workspace explicitly (no middleware resolution needed), and we
 * emit noindex metadata so the preview URL doesn't compete with the
 * customer-facing custom-domain URL for search rankings.
 *
 * Not auth-gated at the Next.js level; relies on the outer middleware
 * auth rules. If unauthenticated users reach this path they still see
 * content, but it's robots-blocked and not indexed.
 */
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>;
}): Promise<Metadata> {
  const { workspace, slug } = await params;
  const data = await getPageData(workspace, slug);
  if (!data) return { title: "Not Found", robots: { index: false, follow: false } };

  const title = data.page_content?.hero_headline || data.product.title;
  return {
    title: `Preview · ${title}`,
    robots: { index: false, follow: false },
    alternates: { canonical: `/store/${workspace}/${slug}` },
  };
}

export default async function StorefrontPreviewPage({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>;
}) {
  const { workspace, slug } = await params;
  const data = await getPageData(workspace, slug);
  if (!data) notFound();

  return (
    <StorefrontPage
      data={data}
      canonicalPath={`/store/${workspace}/${slug}`}
      reviewSlug={slug}
    />
  );
}
