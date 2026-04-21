import type { PageData } from "./page-data";
import { storefrontFont } from "./fonts";

import { HeroSection } from "../_sections/HeroSection";
import { MechanismSection } from "../_sections/MechanismSection";
import { HowItWorksSection } from "../_sections/HowItWorksSection";
import { PriceTableSection } from "../_sections/PriceTableSection";
import { UGCSection } from "../_sections/UGCSection";
import { ComparisonSection } from "../_sections/ComparisonSection";
import { IngredientsSection } from "../_sections/IngredientsSection";
import { ReviewsSection } from "../_sections/ReviewsSection";
import { FAQSection } from "../_sections/FAQSection";
import { FinalCTASection } from "../_sections/FinalCTASection";
import { StickyMobileCTA } from "../_sections/StickyMobileCTA";

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
  const themeStyle = {
    fontFamily: font.stack,
    "--storefront-primary": design.primary_color || "#18181b",
    "--storefront-accent": design.accent_color || "#10b981",
  } as React.CSSProperties;

  // The <img> in HeroSection carries fetchpriority=high, which Chromium
  // treats as a priority hint and starts fetching during HTML parse.
  // We do NOT emit a <link rel="preload"> here: the optimized _next/
  // image URL isn't known at render time (it's a client-side srcset
  // resolution), and an imprecise preload costs more than it saves.

  return (
    <div className={font.className} style={themeStyle}>
      <ProductSchema data={data} canonicalPath={canonicalPath} />
      <FAQSchema data={data} />

      <main className="flex w-full flex-col">
        <HeroSection data={data} />
        <MechanismSection data={data} />
        <HowItWorksSection data={data} />
        <PriceTableSection data={data} />
        <UGCSection data={data} />
        <ComparisonSection data={data} />
        <IngredientsSection data={data} />
        <ReviewsSection data={data} slug={reviewSlug} workspaceSlug={data.workspace.storefront_slug || ""} />
        <FAQSection data={data} />
        <FinalCTASection data={data} />
      </main>

      <StickyMobileCTA data={data} />
    </div>
  );
}

function ProductSchema({
  data,
  canonicalPath,
}: {
  data: PageData;
  canonicalPath: string;
}) {
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(
        ...data.pricing_tiers.map(
          (t) => t.subscribe_price_cents ?? t.price_cents,
        ),
      ) / 100
    : null;

  const schema: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: data.product.title,
    image: data.media_by_slot["hero"]?.url ? [data.media_by_slot["hero"].url] : undefined,
    description: data.page_content?.hero_subheadline || data.product.description,
    url: canonicalPath,
  };
  if (lowestPrice != null) {
    schema.offers = {
      "@type": "Offer",
      priceCurrency: "USD",
      price: lowestPrice.toFixed(2),
      availability: "https://schema.org/InStock",
    };
  }
  if (data.product.rating != null && data.product.rating_count) {
    schema.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: data.product.rating.toFixed(2),
      reviewCount: data.product.rating_count,
    };
  }

  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

function FAQSchema({ data }: { data: PageData }) {
  const items = data.page_content?.faq_items || [];
  if (items.length === 0) return null;
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({
      "@type": "Question",
      name: i.question,
      acceptedAnswer: { "@type": "Answer", text: i.answer },
    })),
  };
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
