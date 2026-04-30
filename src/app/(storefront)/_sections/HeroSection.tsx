import type { PageData } from "../_lib/page-data";
import { StarRating } from "../_components/StarRating";
import { BenefitChip } from "../_components/BenefitChip";
import { ShieldIcon, TrustBadge } from "../_components/TrustBadge";
import { PressLogos } from "../_components/PressLogos";
import { HeroGallery } from "../_components/HeroGallery";

/**
 * Hero — the LCP section. Server component. Pure HTML + CSS.
 *
 * Mobile (default): image on top, headline + CTA below.
 * md+: two-column side-by-side, headline left, image right.
 *
 * The CTA is a native <a href="#pricing"> — native anchor scroll means
 * zero JS to jump to the price table.
 */
export function HeroSection({ data }: { data: PageData }) {
  const heroMedia = data.media_by_slot["hero"] || null;
  const heroGallery = data.media_gallery_by_slot["hero"] || (heroMedia ? [heroMedia] : []);
  const heroAlt = heroMedia?.alt_text || data.product.title;

  const headline =
    data.benefit_angle?.hero_headline ||
    data.page_content?.hero_headline ||
    data.product.title;
  const subhead =
    data.benefit_angle?.hero_subheadline || data.page_content?.hero_subheadline;

  const benefitBar = data.page_content?.benefit_bar || [];
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(
        ...data.pricing_tiers.map(
          (t) => t.subscribe_price_cents ?? t.price_cents,
        ),
      )
    : null;

  const ratingValue = data.product.rating ?? null;
  const ratingCount =
    data.product.rating_count ?? data.review_analysis?.reviews_analyzed_count ?? null;

  // Hero image aspect ratio drives the page-width math. Most product
  // hero shots are roughly 1:1 (bag + props + splash); a 4:3 (1.33)
  // override may apply for wider compositions. We size the page so:
  //   image_width = (2/3) * container_width
  //   image_height = image_width / aspect ≤ viewport_height - chrome
  // Solving: container_width ≤ (vh - 4rem) * (3/2) * aspect
  // Then the image fills its column at full width, no negative space.
  // Hero image aspect — pulled from the actual uploaded asset's
  // width/height (stamped at upload time by the transcoder). Falls
  // back to 4:3 for legacy rows that don't have dimensions yet —
  // there's a backfill script if needed.
  const heroAspectW = heroMedia?.width || 1200;
  const heroAspectH = heroMedia?.height || 900;
  // Container is purely viewport-WIDTH driven. Earlier we coupled
  // width to vh ("scale container so image fits viewport vertically")
  // but that caused the hero to shrink horizontally on short windows
  // — bad UX. The image's max-height is already capped by the sticky
  // h-screen container + object-contain, so we don't need width math
  // to enforce vertical fit.
  const containerStyle: React.CSSProperties = {
    "--hero-aspect-w": String(heroAspectW),
    "--hero-aspect-h": String(heroAspectH),
    maxWidth: "min(2400px, 90vw)",
  } as React.CSSProperties;

  return (
    <section
      data-section="hero"
      className="w-full bg-white"
    >
      {/* Container width is computed dynamically — see containerStyle
          above. The sizing math ensures the image fills 2/3 of the
          container at its natural aspect ratio without exceeding the
          viewport height. On narrower viewports the min(2200px, ...)
          clamp keeps things readable. Capped at 2200px on huge screens. */}
      <div
        style={containerStyle}
        className="mx-auto flex w-full flex-col xl:flex-row xl:items-start xl:gap-10 xl:px-10"
      >
        {/* Hero image — sticky on desktop, top-aligned. Mobile + tablet
            (incl. iPad Pro portrait) keep stacked 4:3 + object-cover
            since the side-by-side layout cramps the text column below
            ~1280px. Side-by-side kicks in at xl: (1280px+) where
            there's room for the image to have wow factor without
            squeezing the headline. */}
        <div className="relative w-full xl:order-1 xl:basis-3/5 xl:sticky xl:top-0 xl:flex xl:h-screen xl:flex-col xl:items-stretch xl:pt-8">
          <HeroGallery
            items={heroGallery}
            altFallback={heroAlt}
            isBestseller={!!data.product.is_bestseller}
            aspectW={heroAspectW}
            aspectH={heroAspectH}
          />
        </div>

        {/* Text column — 2/5 on desktop (xl+), full width on mobile +
            tablet. The section's overall height is driven by this
            column; the sticky image pins until this column scrolls past. */}
        <div className="order-2 flex min-h-[280px] flex-col px-5 pt-6 pb-8 xl:order-2 xl:basis-2/5 xl:px-0 xl:pt-16 xl:pb-16">
          {ratingValue != null && (
            <div className="mb-3 flex items-center gap-2">
              <StarRating rating={ratingValue} size={18} />
              <span className="text-sm text-zinc-600">
                {ratingValue.toFixed(1)}
                {ratingCount ? ` · ${ratingCount.toLocaleString()} reviews` : ""}
              </span>
            </div>
          )}

          <h1 className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
            {data.product.title}
          </h1>
          <p className="mt-2 text-[28px] font-bold leading-[1.1] tracking-tight text-zinc-900 sm:text-4xl md:text-5xl">
            {headline}
          </p>

          {subhead && (
            <p className="mt-3 max-w-xl text-lg leading-relaxed text-zinc-800 sm:text-xl">
              {subhead}
            </p>
          )}

          {benefitBar.length > 0 && (
            <>
              <div className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {benefitBar.slice(0, 4).map((b, i) => (
                  <BenefitChip key={i} label={b.text} index={i} />
                ))}
              </div>
              <ResearchCredibility data={data} />
            </>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="#pricing"
              style={{ backgroundColor: "var(--storefront-primary)" }}
              className="inline-flex h-14 w-full items-center justify-center rounded-full px-8 text-base font-semibold text-white shadow-sm transition-[filter] hover:brightness-90 sm:w-auto"
            >
              {lowestPrice != null
                ? `Try it now — from $${(lowestPrice / 100).toFixed(2)}`
                : "Shop now"}
            </a>
            <TrustBadge icon={<ShieldIcon />} label="30-day money-back" />
          </div>

          <div className="mt-6">
            <PressLogos media={data.media_by_slot} />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * "Backed by N studies on M ingredients in {product}" — the credibility
 * tag that sits under the benefit cards. Numbers come straight from the
 * ingredient_research rows we already loaded for this page; rendering
 * is suppressed when there's nothing meaningful to claim.
 */
function ResearchCredibility({ data }: { data: PageData }) {
  // Count total citations across every ingredient's research rows.
  const studyCount = data.ingredient_research.reduce((sum, r) => {
    return sum + (Array.isArray(r.citations) ? r.citations.length : 0);
  }, 0);

  // Distinct ingredients that actually have research attached — not the
  // raw ingredient list, since some may be supporting / unstudied.
  const ingredientCount = new Set(
    data.ingredient_research.map((r) => r.ingredient_id),
  ).size;

  if (studyCount < 2 || ingredientCount < 2) return null;

  return (
    <p className="mt-4 flex items-center gap-2 text-sm font-medium text-zinc-700">
      <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
      <span>
        Backed by{" "}
        <span className="font-bold text-zinc-900">{studyCount} clinical studies</span> on{" "}
        <span className="font-bold text-zinc-900">{ingredientCount} ingredients</span> in {data.product.title}
      </span>
    </p>
  );
}
