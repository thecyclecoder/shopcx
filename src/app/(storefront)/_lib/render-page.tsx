import dynamic from "next/dynamic";
import type { PageData } from "./page-data";
import { storefrontFont } from "./fonts";
import { pictureSources } from "./image-urls";

// Above-the-fold: imported directly, rendered in initial HTML, part of
// main JS bundle (or zero JS, for server components).
import { HeroSection } from "../_sections/HeroSection";
import { HowItWorksSection } from "../_sections/HowItWorksSection";
import { NutritionistEndorsementSection } from "../_sections/NutritionistEndorsementSection";
import { WhatToExpectTimeline } from "../_sections/WhatToExpectTimeline";

// Below-the-fold: server components still render into the initial
// HTML (no interactive JS anyway), but client components — Reviews,
// FAQ, StickyCTA — are dynamic-imported so their JS lands in a
// separate chunk that only loads after initial render + hydration of
// the critical path.
import { UGCSection } from "../_sections/UGCSection";
import { ComparisonSection } from "../_sections/ComparisonSection";
import { IngredientsSection } from "../_sections/IngredientsSection";
import { FinalCTASection } from "../_sections/FinalCTASection";
import { StorefrontHeader } from "../_components/StorefrontHeader";
import { ProductJsonLd } from "../_components/ProductJsonLd";

// PriceTable is mid-page but interactive on first scroll — load its
// JS with the page but in a separate chunk so it doesn't inflate the
// main runtime. ssr: true so the price table HTML is still in the
// initial response for SEO + instant paint.
const PriceTableSection = dynamic(
  () => import("../_sections/PriceTableSection").then((m) => m.PriceTableSection),
);

const ReviewsSection = dynamic(
  () => import("../_sections/ReviewsSection").then((m) => m.ReviewsSection),
);

const FAQSection = dynamic(
  () => import("../_sections/FAQSection").then((m) => m.FAQSection),
);

// Replaced StickyMobileCTA (sticky 'Order now' bar) with a recent-orders
// social-proof toast. The page already has prominent CTAs in the hero,
// why-this-works, and final-CTA sections — this small toast reinforces
// 'real people are buying this' without adding a redundant button.
const RecentOrdersToast = dynamic(
  () => import("../_components/RecentOrdersToast").then((m) => m.RecentOrdersToast),
);

/**
 * Shared render layer used by both the public route (/[slug]) and the
 * admin preview route (/store/[workspace]/[slug]). Both pages pull the
 * same data and render the same 10 sections — only the URL, canonical,
 * and noindex flag differ.
 */
export function StorefrontPage({
  data,
  canonicalPath,
  reviewSlug,
}: {
  data: PageData;
  canonicalPath: string;
  reviewSlug: string;
}) {
  // Per-workspace theming via CSS custom properties. The font allowlist
  // is pre-registered in next/font so the browser picks the right file;
  // primary/accent colors flow through Tailwind arbitrary values and
  // inline styles on buttons.
  const design = data.workspace.design || {};
  const font = storefrontFont(design.font_key || null);
  // Body text uses the OS-native system font (faster to render, more
  // legible at paragraph sizes). Only headings (h1–h6) inherit the
  // workspace's chosen display font — see globals.css for the
  // `.storefront-root` rules that key off these two CSS vars.
  const SYSTEM_BODY_STACK =
    "-apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif";
  const themeStyle = {
    "--storefront-heading-font": font.stack,
    "--storefront-body-font": SYSTEM_BODY_STACK,
    "--storefront-primary": design.primary_color || "#18181b",
    "--storefront-accent": design.accent_color || "#10b981",
  } as React.CSSProperties;

  // Hero image preload. The srcset/sizes exactly mirror the <picture>
  // in HeroSection, so the browser picks the same variant via the
  // preload that it would from the DOM — but the preload is in <head>,
  // not deep in the body. Vercel auto-extracts <link rel=preload> from
  // the HTML into an HTTP 103 Early Hints response, so the browser
  // starts downloading the hero during TTFB instead of after parse.
  const heroSources = pictureSources(
    data.media_by_slot["hero"],
    data.product.title,
    "(min-width: 768px) 50vw, 100vw",
  );

  return (
    <div className={font.className} style={themeStyle}>
      {heroSources?.avifSrcSet && (
        <link
          rel="preload"
          as="image"
          type="image/avif"
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...({
            imageSrcSet: heroSources.avifSrcSet,
            imageSizes: heroSources.sizes,
            fetchPriority: "high",
          } as any)}
        />
      )}
      <ProductJsonLd data={data} canonicalUrl={canonicalPath} />

      <StorefrontHeader
        workspaceId={data.product.workspace_id}
        productId={data.product.id}
        productHandle={data.product.handle}
        productTitle={data.product.title}
        headerText={data.product.header_text}
        headerColor={data.product.header_text_color}
        headerWeight={data.product.header_text_weight}
      />

      <main className="flex w-full flex-col">
        <HeroSection data={data} />
        {/* HowItWorksSection ("Why this works") now absorbs what
            MechanismSection used to render — single block below the
            hero with image + CTA. MechanismSection still exists in
            the codebase but is no longer in the flow. */}
        <HowItWorksSection data={data} />
        <UGCSection data={data} slug={reviewSlug} workspaceSlug={data.workspace.storefront_slug || ""} />
        <ComparisonSection data={data} />
        <IngredientsSection data={data} />
        <NutritionistEndorsementSection data={data} />
        <WhatToExpectTimeline data={data} />
        <PriceTableSection data={data} />
        <ReviewsSection data={data} slug={reviewSlug} workspaceSlug={data.workspace.storefront_slug || ""} />
        <FAQSection data={data} />
        <FinalCTASection data={data} />
      </main>

      <RecentOrdersToast orders={data.recent_orders_for_proof} />
    </div>
  );
}

