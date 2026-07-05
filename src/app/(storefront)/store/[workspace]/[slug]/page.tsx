import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { cacheLife, cacheTag } from "next/cache";
import type { Metadata } from "next";

import { getPageData, listPublishedProducts, type PageData, type MediaItem } from "../../../_lib/page-data";
import { StorefrontPage } from "../../../_lib/render-page";
import { loadAdvertorialContent, type AdvertorialVariant } from "@/lib/advertorial-pages";
import {
  loadBlueprintRenderContent,
  type BlueprintRenderContent,
} from "@/lib/blueprint-render";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolveExperimentsForRender,
  resolvePdpExperimentsForRender,
  loadEdgeAssignedPdpHero,
  parsePreviewParam,
  type ExperimentExposureMeta,
} from "@/lib/storefront/experiments";

/**
 * Additional ?variant= values reachable BEYOND the three
 * AdvertorialVariant landers — one per lander_blueprints.funnel_type Cleo's
 * blueprint-authoring session has produced. When a URL carries
 * `?variant=advertorial-listicle` we load the matching blueprint by
 * (workspace_id, product_id, funnel_type) and render its skeleton via
 * `BlueprintLander`. New funnel_type values land here as blueprints get
 * built; the render is generic across funnel_types (block-by-block).
 */
const BLUEPRINT_VARIANTS = new Set<string>(["advertorial-listicle"]);

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
 * The bare PDP resolves experiments at the EDGE now (pdp-edge-served-experiments
 * Phase 2): the middleware sticky-assigns the variant + rewrites served arms to a
 * variant-keyed URL (`?_sxv=<variantId>`), so each arm is a DISTINCT edge-cached
 * render — fast AND tested, no per-request server compute. The page reads the
 * assigned arm from `_sxv` (no `cookies()` read → stays cacheable) and overrides
 * the `hero` media slot; control/holdout get the real cached PDP. No `_sxv` and no
 * `?variant=` → the param-less static prerender is preserved. Exposure for the
 * assigned arm emits client-side from the `sx_variant` cookie (the pixel),
 * internal/bot excluded.
 */

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

/**
 * Edge-assigned PDP render — cached per `(workspace, slug, sxv)` so the
 * pdp-edge-served-experiments per-arm cache contract holds in Next 16.
 *
 * Next 16 + cacheComponents replaces the legacy `revalidate = 3600` route
 * segment knob with the `'use cache'` directive. Reading `searchParams` at
 * the page top forces dynamic rendering on every request, so the cacheable
 * work has to be lifted into a helper whose only inputs are the cache-key
 * args. Each unique `(workspace, slug, sxv)` produces ONE cached PageData;
 * the same arm-keyed URL serves from CDN as `x-vercel-cache: HIT` after
 * warm-up. `sxv = null` is the control/holdout/bare PDP — also cached.
 *
 * The `storefront-experiment:<workspaceId>:<productId>` tag lets
 * republishExperimentManifest purge every arm's cache entry in one call
 * on materializeCampaign / promote / kill / rollback (it already runs
 * revalidatePath; revalidateTag covers per-arm `_sxv` entries even when
 * the path-level purge doesn't propagate to argument-keyed cache entries).
 */
async function renderEdgeAssignedPdp(
  workspace: string,
  slug: string,
  sxv: string | null,
): Promise<PageData | null> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });

  const data = await getPageData(workspace, slug);
  if (!data) return null;

  cacheTag(`storefront-experiment:${data.workspace.id}:${data.product.id}`);

  if (sxv) {
    try {
      const heroUrl = await loadEdgeAssignedPdpHero(
        createAdminClient(),
        data.workspace.id,
        data.product.id,
        sxv,
      );
      if (heroUrl) return applyPdpHeroOverride(data, heroUrl);
    } catch {
      /* experiment substrate is best-effort — fall back to the control PDP */
    }
  }

  return data;
}

export async function generateStaticParams() {
  return listPublishedProducts();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>;
}): Promise<Metadata> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });
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
  // `_sxv=<variantId>` is the edge-assigned PDP arm (pdp-edge-served-experiments):
  // the middleware sticky-assigned the visitor + rewrote to this variant-keyed URL
  // so each arm is a distinct cacheable render.
  searchParams: Promise<{ variant?: string; angle?: string; sx_preview?: string; _sxv?: string }>;
}) {
  const { workspace, slug } = await params;
  const sp = await searchParams;

  const variant: AdvertorialVariant | null =
    sp.variant === "advertorial" || sp.variant === "beforeafter" || sp.variant === "reasons" ? sp.variant : null;
  const blueprintVariant = !variant && sp.variant && BLUEPRINT_VARIANTS.has(sp.variant) ? sp.variant : null;
  const preview = !variant && !blueprintVariant ? parsePreviewParam(sp.sx_preview) : null;
  const isDynamic = Boolean(variant || blueprintVariant || preview);

  // Bare PDP branch. Edge-served A/B (pdp-edge-served-experiments Phase 2):
  // assignment happens at the Vercel edge (middleware), NOT inline here — so the
  // PDP stays edge-cached per variant instead of going fully dynamic under test.
  // The cached helper is keyed by `(workspace, slug, sxv)` so each arm gets its
  // own cache entry (`sxv = null` covers control / holdout / no-experiment).
  // Exposure for the assigned arm emits client-side from the `sx_variant`
  // cookie (the pixel) so we don't read cookies here and stay cacheable.
  const data = isDynamic
    ? await getPageData(workspace, slug)
    : await renderEdgeAssignedPdp(workspace, slug, sp._sxv ?? null);
  if (!data) notFound();

  // Storefront experiments. Sticky-assign the visitor (by their `sid`
  // anonymous_id) to an active experiment's arm and hand the resulting exposures
  // to the client pixel to emit. Best-effort — never blocks the render.
  let experimentExposures: ExperimentExposureMeta[] = [];
  let renderData = data;
  let advertorial = variant ? await loadAdvertorialContent(data, variant, sp.angle ?? null) : null;
  let blueprint: BlueprintRenderContent | null = null;
  if (blueprintVariant) {
    // Blueprint lander: the ?variant= value matches lander_blueprints.funnel_type
    // for a (workspace, product) pair Cleo authored + Carrie filled. When no
    // matching content_complete row exists (or the blueprint's `content` isn't
    // filled yet), 404 — a not-yet-public blueprint must not be reachable.
    try {
      blueprint = await loadBlueprintRenderContent(
        data.workspace.id,
        data.product.id,
        blueprintVariant,
      );
    } catch {
      blueprint = null;
    }
    if (!blueprint) notFound();
  }

  if (variant && advertorial) {
    // Ad-matched lander branch (advertorial / before-after / reasons): patch the
    // AdvertorialContent. Already dynamic (reads searchParams + cookies).
    try {
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
        preview: parsePreviewParam(sp.sx_preview),
      });
      advertorial = resolved.content;
      experimentExposures = resolved.exposures;
    } catch {
      /* experiment substrate is best-effort — fall back to control content */
    }
  } else if (preview) {
    // Owner-only detail-page preview (`?sx_preview=<exp>:<variant>`, no
    // `variant=`): force the arm regardless of assignment. Dynamic by design
    // (reads searchParams) — `sx_internal=1` drops the exposure at the pixel.
    try {
      const resolved = await resolvePdpExperimentsForRender({
        admin: createAdminClient(),
        workspaceId: data.workspace.id,
        productId: data.product.id,
        identityKey: null,
        conservative: true,
        preview,
      });
      if (resolved.heroImageUrl) renderData = applyPdpHeroOverride(data, resolved.heroImageUrl);
      experimentExposures = resolved.exposures;
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
      blueprint={blueprint}
      experimentExposures={experimentExposures}
    />
  );
}
