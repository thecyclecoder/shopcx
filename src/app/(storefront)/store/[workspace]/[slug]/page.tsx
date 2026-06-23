import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import type { Metadata } from "next";

import { getPageData, listPublishedProducts, type PageData, type MediaItem } from "../../../_lib/page-data";
import { StorefrontPage } from "../../../_lib/render-page";
import { loadAdvertorialContent, type AdvertorialVariant } from "@/lib/advertorial-pages";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveExperimentsForRender,
  resolvePdpExperimentsForRender,
  loadActiveExperiments,
  parsePreviewParam,
  type ExperimentExposureMeta,
} from "@/lib/storefront/experiments";

/**
 * The single storefront route.
 *
 * Two external URL shapes both render this page:
 *   1. Admin preview:     shopcx.ai/store/{workspace}/{slug}
 *   2. Public storefront: {custom-domain}/{slug}
 *      — middleware rewrites to /store/{workspace}/{slug} internally
 *        so both hit this same SSG'd HTML.
 *
 * Crucially, the param-less PDP does NOT read headers() or cookies(), so
 * Next.js can statically generate every (workspace, slug) pair via
 * generateStaticParams and serve from Vercel's edge CDN with sub-100ms
 * TTFB. Robots/indexing differs between the two hosts: middleware sets
 * X-Robots-Tag: noindex on shopcx.ai requests so the preview URL
 * doesn't compete with the customer-facing canonical.
 *
 * Ad-matched landers (`?variant=…&angle=…`) ALREADY render dynamically
 * (they read searchParams), so — and in that branch — we read the `sid`
 * cookie to sticky-assign storefront experiments.
 *
 * The bare PDP ALSO resolves experiments now (pdp-experiment-wiring Phase 1),
 * but stays ISR-cached on the common path: it reads the `sid` cookie — the only
 * thing that forces dynamic rendering — ONLY when an active `(product, pdp)`
 * experiment exists (a `loadActiveExperiments` check that itself touches no
 * cookies). No active PDP experiment → no cookie read → the static prerender is
 * preserved. With one active, the PDP renders dynamically per-visitor and the
 * assigned arm's hero overrides the `hero` media slot.
 */
export const revalidate = 3600;
export const dynamicParams = true;

/**
 * Override the PDP `hero` media slot with an experiment variant's hero image.
 * The variant carries a single generated/public URL (the ad-tool hero), not a
 * pre-transcoded responsive `MediaItem`, so the optimized/responsive variants
 * are nulled — `pictureSources` falls back to the plain `url` (proxied through
 * the edge CDN like any other hero). The control hero's dimensions + alt are
 * kept for stable aspect-ratio layout. Returns a shallow clone; the original
 * `data` (the control render) is never mutated.
 */
function applyPdpHeroOverride(data: PageData, heroUrl: string): PageData {
  const base = data.media_by_slot["hero"] ?? null;
  const overridden: MediaItem = {
    slot: "hero",
    url: heroUrl,
    webp_url: null,
    avif_url: null,
    avif_480_url: null,
    webp_480_url: null,
    avif_750_url: null,
    webp_750_url: null,
    avif_1080_url: null,
    webp_1080_url: null,
    avif_1500_url: null,
    webp_1500_url: null,
    avif_1920_url: null,
    webp_1920_url: null,
    alt_text: base?.alt_text ?? data.product.title,
    width: base?.width ?? null,
    height: base?.height ?? null,
  };
  // Swap only the primary (display_order=0) hero image; the rest of the hero
  // gallery (additional product shots) is preserved.
  const galleryRest = (data.media_gallery_by_slot["hero"] ?? []).slice(1);
  return {
    ...data,
    media_by_slot: { ...data.media_by_slot, hero: overridden },
    media_gallery_by_slot: {
      ...data.media_gallery_by_slot,
      hero: [overridden, ...galleryRest],
    },
  };
}

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
  // `sx_preview=<experimentId>:<variantId>` is the owner-only detail-page preview
  // (forces one arm; paired with `sx_internal=1` so it never pollutes the bandit).
  searchParams: Promise<{ variant?: string; angle?: string; sx_preview?: string }>;
}) {
  const { workspace, slug } = await params;
  const sp = await searchParams;
  const data = await getPageData(workspace, slug);
  if (!data) notFound();

  const variant: AdvertorialVariant | null =
    sp.variant === "advertorial" || sp.variant === "beforeafter" || sp.variant === "reasons" ? sp.variant : null;
  let advertorial = variant ? await loadAdvertorialContent(data, variant, sp.angle ?? null) : null;

  // Storefront experiments. Sticky-assign the visitor (by their `sid`
  // anonymous_id) to an active experiment's arm and hand the resulting exposures
  // to the client pixel to emit. Best-effort — never blocks the render.
  let experimentExposures: ExperimentExposureMeta[] = [];
  // The data handed to the render; the bare-PDP hero experiment swaps the `hero`
  // media slot on a clone (the control PDP's `data` is left untouched).
  let renderData = data;
  if (variant && advertorial) {
    // Ad-matched lander branch (advertorial / before-after / reasons): patch the
    // AdvertorialContent. Already dynamic (reads searchParams).
    try {
      const preview = parsePreviewParam(sp.sx_preview);
      const identityKey = (await cookies()).get("sid")?.value ?? null;
      const resolved = await resolveExperimentsForRender({
        admin: createAdminClient(),
        workspaceId: data.workspace.id,
        productId: data.product.id,
        renderVariant: variant,
        identityKey,
        content: advertorial,
        // Conservative until M3's LTV-proxy reconciler calibrates (the goal's
        // "run conservatively until the slow loop calibrates" rule).
        conservative: true,
        // Owner-only detail-page preview forces a specific arm; the paired
        // `sx_internal=1` cookie drops the exposure at the pixel write.
        preview,
      });
      advertorial = resolved.content;
      experimentExposures = resolved.exposures;
    } catch {
      /* experiment substrate is best-effort — fall back to control content */
    }
  } else if (!variant) {
    // Bare PDP branch (pdp-experiment-wiring Phase 1). The PDP hero renders from
    // `media_by_slot["hero"]`, so the assigned arm's `heroImageUrl` overrides
    // that slot. Dynamic-only-when-testing: we read the `sid` cookie (the only
    // dynamic API here) ONLY when an active `(product, pdp)` experiment exists,
    // so the no-experiment common case stays ISR-cached.
    try {
      const admin = createAdminClient();
      const preview = parsePreviewParam(sp.sx_preview);
      if (preview) {
        // Owner-only detail-page preview (`?sx_preview=<exp>:<variant>`, no
        // `variant=`): force the arm regardless of assignment. Already dynamic
        // (reads searchParams) — no cookie needed; `sx_internal=1` drops the
        // exposure at the pixel.
        const resolved = await resolvePdpExperimentsForRender({
          admin,
          workspaceId: data.workspace.id,
          productId: data.product.id,
          identityKey: null,
          conservative: true,
          preview,
        });
        if (resolved.heroImageUrl) renderData = applyPdpHeroOverride(data, resolved.heroImageUrl);
        experimentExposures = resolved.exposures;
      } else {
        const active = await loadActiveExperiments(admin, data.workspace.id, data.product.id, "pdp");
        if (active.length) {
          // An active PDP experiment exists → go dynamic (read the `sid` cookie)
          // and sticky-assign this visitor.
          const identityKey = (await cookies()).get("sid")?.value ?? null;
          const resolved = await resolvePdpExperimentsForRender({
            admin,
            workspaceId: data.workspace.id,
            productId: data.product.id,
            identityKey,
            conservative: true,
          });
          if (resolved.heroImageUrl) renderData = applyPdpHeroOverride(data, resolved.heroImageUrl);
          experimentExposures = resolved.exposures;
        }
        // else: no active experiment → never touched cookies → ISR cache intact.
      }
    } catch {
      /* experiment substrate is best-effort — fall back to the control PDP */
    }
  }

  const canonical = data.workspace.storefront_domain
    ? `https://${data.workspace.storefront_domain}/${slug}`
    : `/store/${workspace}/${slug}`;

  return (
    <StorefrontPage
      data={renderData}
      canonicalPath={canonical}
      reviewSlug={slug}
      advertorial={advertorial}
      experimentExposures={experimentExposures}
    />
  );
}
