import dynamic from "next/dynamic";
import type { PageData } from "./page-data";
import { storefrontFont } from "./fonts";
import { pictureSources } from "./image-urls";

// Above-the-fold: imported directly, rendered in initial HTML, part of
// main JS bundle (or zero JS, for server components).
import { HeroSection } from "../_sections/HeroSection";
import { CompleteOrderBanner } from "../_components/CompleteOrderBanner";
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
import { StorefrontPixelInit } from "../_components/StorefrontPixelInit";
import { StorefrontChapterTracker } from "../_components/StorefrontChapterTracker";
import { SmartPopup } from "../_components/SmartPopup";
import { SurveyChapter } from "../_sections/SurveyChapter";
import { BrandTrustSection } from "../_sections/BrandTrustSection";
import { StorefrontFooter } from "../_components/StorefrontFooter";
import { ActiveMemberProvider } from "./active-member-context";
import { PricingModeProvider } from "./pricing-mode-context";
import { AutoCouponProvider } from "../_components/AutoCouponProvider";
import { AutoCouponWelcome } from "../_components/AutoCouponWelcome";
import { UpsellChapter } from "../_sections/UpsellChapter";
// Advertorial / before-after lander sections (ad-matched layout modes). Only
// rendered when `advertorial` content is passed (via ?variant=…&angle=…).
import { AdvertorialHero } from "../_sections/AdvertorialHero";
import { AdvertorialChapter } from "../_sections/AdvertorialChapter";
import { ReasonsListicle } from "../_sections/ReasonsListicle";
import { BeforeAfterHero } from "../_sections/BeforeAfterHero";
import { WeightLossTestimonialWall } from "../_sections/WeightLossTestimonialWall";
import { BlueprintLander } from "../_sections/BlueprintLander";
import { StickyJumpNav } from "../_components/StickyJumpNav";
import type { AdvertorialContent } from "@/lib/advertorial-pages";
import type { BlueprintRenderContent } from "@/lib/blueprint-render";
import type { ExperimentExposureMeta } from "@/lib/storefront/experiments";

// PriceTable is mid-page but interactive on first scroll — load its
// JS with the page but in a separate chunk so it doesn't inflate the
// main runtime. ssr: true so the price table HTML is still in the
// initial response for SEO + instant paint.
const PriceTableSection = dynamic(
  () => import("../_sections/PriceTableSection").then((m) => m.PriceTableSection),
);

// BundlePriceTableSection only renders when an upsell partner is
// configured + complementarity copy is set. Loaded lazily to keep
// the main bundle lean on pages where it's not used.
const BundlePriceTableSection = dynamic(
  () => import("../_sections/BundlePriceTableSection").then((m) => m.BundlePriceTableSection),
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
  advertorial = null,
  blueprint = null,
  experimentExposures = [],
}: {
  data: PageData;
  canonicalPath: string;
  reviewSlug: string;
  /** When set, renders an ad-matched lander layout (advertorial / before-after)
   *  instead of the standard PDP. The custom top swaps; everything below the
   *  custom top (ingredients, pricing, reviews, checkout) is reused unchanged. */
  advertorial?: AdvertorialContent | null;
  /** When set, renders a blueprint-driven lander (whole-missing-funnel-type
   *  authored by Cleo + filled by Carrie) instead of the standard PDP. Every
   *  block above the SHARED-CHECKOUT closers (ingredients / pricing / reviews)
   *  comes from `content.blocks[]` — no fallback derivation. */
  blueprint?: BlueprintRenderContent | null;
  /** Storefront-experiment exposures resolved server-side (sticky assignment) for
   *  the client pixel to emit as `experiment_exposure` events. */
  experimentExposures?: ExperimentExposureMeta[];
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

      {/* Storefront pixel — pdp_view fires on mount, pdp_engaged on
          first click/scroll/dwell, pack_selected on Select CTA via
          delegated handler. No UI rendered. */}
      <StorefrontPixelInit
        workspaceId={data.workspace.id}
        productId={data.product.id}
        productHandle={data.product.handle}
        metaPixelId={data.workspace.meta_pixel_id}
        skipCustomize={data.workspace.storefront_skip_customize}
        experimentExposures={experimentExposures}
      />
      {/* Phase 2 instrumentation — observes [data-section] nodes for
          chapter_view/dwell, tracks scroll_depth + cta_click. No UI. */}
      <StorefrontChapterTracker
        productId={data.product.id}
        pageVariant={blueprint ? "blueprint" : advertorial?.variant ?? "pdp"}
      />
      {/* Phase 4 — behaviorally-triggered smart popup. Silent for
          decisive buyers; intervenes only on hesitation/indecision. */}
      {/* PDPs only — advertorial/blueprint landers stay distraction-free (no lead-capture popup). */}
      {!advertorial && !blueprint && (
        <SmartPopup
          workspaceId={data.workspace.id}
          productId={data.product.id}
          productHandle={data.product.handle}
          hasActiveSub={false}
          benefitOptions={data.benefit_selections.map((b) => b.benefit_name).filter(Boolean)}
        />
      )}

      {/* No storefront chrome on advertorial/before-after/blueprint landers — the
          fixed brand nav breaks the "native editorial article" illusion that
          makes these landers convert. Their editorial hero/masthead stands in
          for it. */}
      {!advertorial && !blueprint && (
        <StorefrontHeader
          workspaceId={data.product.workspace_id}
          productId={data.product.id}
          productHandle={data.product.handle}
          productTitle={data.product.title}
          headerText={data.product.header_text}
          headerColor={data.product.header_text_color}
          headerWeight={data.product.header_text_weight}
        />
      )}

      <AutoCouponProvider workspaceId={data.workspace.id}>
      <AutoCouponWelcome />
      <ActiveMemberProvider
        initialMemberId={
          data.link_group?.members.find((m) => m.is_current)?.member_id ?? null
        }
      >
        <PricingModeProvider
          initialMode={
            // Default to subscribe when the product has a sub discount
            // configured (preserves the existing default behavior for
            // most products, which all subscribe by default).
            (data.pricing_rule?.subscribe_discount_pct || 0) > 0 ? "subscribe" : "onetime"
          }
          initialFreqDays={
            // Pull from the primary product's rule: the flagged-default
            // frequency, else the first available.
            (() => {
              const fs = data.pricing_rule?.available_frequencies || [];
              const def = fs.find(f => f.default) || fs[0] || null;
              return def?.interval_days ?? null;
            })()
          }
        >
          <main className="flex w-full flex-col">
            {blueprint ? (
              <>
                {/* Blueprint-driven lander: every above-the-fold block comes
                    from lander_blueprints.content.blocks[] (Carrie's copy +
                    resolved product_media). The SHARED-CHECKOUT closers
                    (ingredients / pricing / reviews / final CTA) are reused
                    unchanged so the buy-flow matches every other lander. */}
                <BlueprintLander data={data} content={blueprint} />
                <IngredientsSection data={data} />
                <PriceTableSection data={data} />
                <ReviewsSection
                  data={data}
                  slug={reviewSlug}
                  workspaceSlug={data.workspace.storefront_slug || ""}
                />
                <FinalCTASection data={data} />
                <BrandTrustSection workspaceName={data.workspace.name || "Superfoods Company"} />
              </>
            ) : advertorial ? (
              advertorial.variant === "reasons" ? (
                <>
                  {/* "N reasons why" listicle lander: editorial hero → numbered
                      reasons (with mid-list CTA) → reuse ingredients / pricing /
                      reviews / checkout unchanged. */}
                  <AdvertorialHero data={data} content={advertorial} />
                  <StickyJumpNav />
                  <ReasonsListicle data={data} content={advertorial} />
                  <IngredientsSection data={data} />
                  <PriceTableSection data={data} />
                  <ReviewsSection data={data} slug={reviewSlug} workspaceSlug={data.workspace.storefront_slug || ""} />
                  <FinalCTASection data={data} />
                  <BrandTrustSection workspaceName={data.workspace.name || "Superfoods Company"} />
                </>
              ) : advertorial.variant === "beforeafter" ? (
                <>
                  {/* Before/after lander: unique chapters 1-3 (transformation
                      hero → PDP hero → weight-loss testimonial wall), then the
                      SAME full chapter body as the standard PDP — variants must
                      never have fewer chapters than the main PDP. */}
                  <BeforeAfterHero data={data} content={advertorial} />
                  <HeroSection data={data} />
                  <StickyJumpNav />
                  <WeightLossTestimonialWall data={data} />
                  <StandardChapters data={data} reviewSlug={reviewSlug} />
                </>
              ) : (
                <>
                  {/* Advertorial lander: unique chapters 1-3 (editorial hero →
                      narrative chapter), then the SAME full chapter body as the
                      standard PDP — variants must never have fewer chapters. */}
                  <AdvertorialHero data={data} content={advertorial} />
                  <StickyJumpNav />
                  <AdvertorialChapter data={data} content={advertorial} />
                  <StandardChapters data={data} reviewSlug={reviewSlug} />
                </>
              )
            ) : (
            <>
            <CompleteOrderBanner guaranteeCopy={data.page_content?.guarantee_copy ?? null} />
            <HeroSection data={data} />
            {/* Survey chapter — interactive lead-capture quiz placed right
                after the hero to rescue the ~70% hero→ch1 drop-off, capture
                zero-party data, and gate the signup code behind email/phone.
                Replaces the (structurally dead) quiz popup variant. Hardcoded
                coffee-specific ("1 cup/2 cups", coffee styles), so it only
                renders for products with show_survey=true (the coffee products)
                — non-coffee products would show a nonsensical survey otherwise.
                (Lander refinements round 3.) */}
            {data.page_content?.show_survey && <SurveyChapter data={data} />}
            {/* Shared content body — the full chapter set, identical across
                the standard PDP and the ad variants (see StandardChapters). */}
            <StandardChapters data={data} reviewSlug={reviewSlug} />
            </>
            )}
          </main>
          <StorefrontFooter
            workspaceName={data.workspace.name || "Superfoods Company"}
            supportEmail={data.workspace.support_email}
          />
        </PricingModeProvider>
      </ActiveMemberProvider>
      </AutoCouponProvider>

      {/* PDPs only — no "someone just bought" toast on the distraction-free landers. */}
      {!advertorial && !blueprint && <RecentOrdersToast orders={data.recent_orders_for_proof} />}
    </div>
  );
}

/**
 * The full PDP content body — every chapter below the hero/intro. Shared
 * by the standard PDP and the advertorial / before-after variants so the
 * variants never carry fewer chapters than the main page; they only swap
 * the intro (chapters 1-3) and then render this identical set.
 *
 * Order: converter-first (why-this-works, ingredients run before pricing
 * while attention is highest), then the "learn more" zone below the price
 * table for shoppers who scroll past pricing wanting more.
 */
function StandardChapters({ data, reviewSlug }: { data: PageData; reviewSlug: string }) {
  const wsSlug = data.workspace.storefront_slug || "";
  const wsName = data.workspace.name || "Superfoods Company";
  return (
    <>
      <HowItWorksSection data={data} />
      <IngredientsSection data={data} />
      {/* Expert endorsement sits right under ingredients — credentials
          reinforce the ingredient story before the customer reaches pricing. */}
      <NutritionistEndorsementSection data={data} />
      {/* Upsell complementarity chapter — only renders when the primary has
          an upsell partner + saved copy. Sits before pricing so the bundle
          pitch is set up first. */}
      <UpsellChapter data={data} />
      <PriceTableSection data={data} />
      <BundlePriceTableSection data={data} />
      {/* "Learn more" zone — detail / social-proof chapters for shoppers who
          scroll past pricing. Kept, not cut. */}
      <UGCSection data={data} slug={reviewSlug} workspaceSlug={wsSlug} />
      <ComparisonSection data={data} />
      <WhatToExpectTimeline data={data} />
      <ReviewsSection data={data} slug={reviewSlug} workspaceSlug={wsSlug} />
      <FAQSection data={data} />
      <FinalCTASection data={data} />
      <BrandTrustSection workspaceName={wsName} />
    </>
  );
}

