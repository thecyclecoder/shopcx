import type { PageData } from "../_lib/page-data";
import { bestMediaUrl } from "../_lib/page-data";
import { StarRating } from "../_components/StarRating";
import { BenefitChip } from "../_components/BenefitChip";
import { ShieldIcon, TrustBadge } from "../_components/TrustBadge";
import { PressLogos } from "../_components/PressLogos";
import { ImageOrPlaceholder } from "../_components/ImageOrPlaceholder";

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
  // Prefer the AVIF/WebP variant written by the upload transcoder —
  // even through Vercel's optimizer, a pre-compressed source halves
  // transfer bytes on cold cache.
  const heroImage = bestMediaUrl(data.media_by_slot["hero"]);
  const heroAlt =
    data.media_by_slot["hero"]?.alt_text || data.product.title;

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

  return (
    <section
      data-section="hero"
      className="flex min-h-[600px] w-full flex-col bg-white"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col md:flex-row md:items-center md:gap-12 md:px-8 md:pt-16 md:pb-16">
        {/* Hero image — single <img>, CSS swaps position between mobile
            (above text, 4:3, full-bleed) and desktop (right side, 1:1) */}
        <div
          className="relative w-full overflow-hidden md:order-2 md:flex-1 md:rounded-2xl"
          style={
            {
              "--mobile-aspect": "4 / 3",
              "--desktop-aspect": "1 / 1",
            } as React.CSSProperties
          }
        >
          <div
            className="relative w-full"
            style={{ aspectRatio: "4 / 3" }}
          >
            <div className="absolute inset-0 md:static md:aspect-square">
              <ImageOrPlaceholder
                src={heroImage}
                alt={heroAlt}
                fill
                sizes="(min-width: 768px) 50vw, 100vw"
                priority
                fetchPriority="high"
                aspect="4/3"
                className="object-cover"
              />
            </div>
          </div>
        </div>

        {/* Text column */}
        <div className="order-2 flex min-h-[280px] flex-col px-5 pt-6 pb-8 md:order-1 md:flex-1 md:px-0 md:pt-0 md:pb-0">
          {ratingValue != null && (
            <div className="mb-3 flex items-center gap-2">
              <StarRating rating={ratingValue} size={18} />
              <span className="text-sm text-zinc-600">
                {ratingValue.toFixed(1)}
                {ratingCount ? ` · ${ratingCount.toLocaleString()} reviews` : ""}
              </span>
            </div>
          )}

          <h1 className="text-[28px] font-bold leading-[1.1] tracking-tight text-zinc-900 sm:text-4xl md:text-5xl">
            {headline}
          </h1>

          {subhead && (
            <p className="mt-3 max-w-xl text-base text-zinc-600 sm:text-lg">
              {subhead}
            </p>
          )}

          {benefitBar.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {benefitBar.slice(0, 6).map((b, i) => (
                <BenefitChip key={i} label={b.text} />
              ))}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="#pricing"
              className="inline-flex h-14 w-full items-center justify-center rounded-full bg-zinc-900 px-8 text-base font-semibold text-white shadow-sm transition-colors hover:bg-zinc-800 sm:w-auto"
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
