"use client";

import { usePathname } from "next/navigation";
import type { PageData, MediaItem } from "../_lib/page-data";
import { useActiveMember } from "../_lib/active-member-context";
import { StarRating } from "../_components/StarRating";
import { BenefitChip } from "../_components/BenefitChip";
import { ShopCTA } from "../_components/ShopCTA";
import { PressLogos } from "../_components/PressLogos";
import { HeroGallery } from "../_components/HeroGallery";
import { HeroFeaturedReviews } from "../_components/HeroFeaturedReviews";
import { PressQuote } from "../_components/PressQuote";
import { TrustChipRow } from "../_components/TrustChipRow";

/**
 * Hero — the LCP section. Client component (the format toggle for
 * linked products needs useState; the rest of the markup is otherwise
 * pure HTML + CSS so hydration cost stays low).
 *
 * Mobile (default): image on top, headline + CTA below.
 * md+: two-column side-by-side, headline left, image right.
 *
 * The CTA is a native <a href="#pricing"> on the current product —
 * native anchor scroll means zero JS to jump to the price table. When
 * a linked member is selected, href flips to that member's product
 * page since this page's price table is for the wrong format.
 */
export function HeroSection({ data, bundle = false }: { data: PageData; bundle?: boolean }) {
  const pathname = usePathname() || "";
  // Bundle PDP: same hero as the standard PDP, with three swaps — the main image is the composed
  // bundle shot (bundle_hero slot), the CTA is "Select Bundle" (adds to cart here, no scroll to a
  // price table), and the linked-product format toggle is hidden (a bundle isn't a K-Cups/Instant swap).
  const heroMedia = (bundle ? data.media_by_slot["bundle_hero"] : null) || data.media_by_slot["hero"] || null;
  const heroGallery = bundle
    ? (heroMedia ? [heroMedia] : [])
    : data.media_gallery_by_slot["hero"] || (heroMedia ? [heroMedia] : []);
  const heroAlt = heroMedia?.alt_text || data.product.title;

  // Format toggle (linked products). When the customer toggles to a
  // linked member (e.g. K-Cups on the Amazing Coffee page), the hero
  // image swaps to that member's hero and the servings chip updates.
  // Default selection = the current product (is_current=true). This
  // intentionally does NOT change the price-table / pricing tiers
  // shown below the hero in phase 1; that wiring comes in phase 3.
  const linkGroup = data.link_group;
  const sortedMembers = linkGroup ? [...linkGroup.members].sort((a, b) => a.display_order - b.display_order) : [];
  // Active member state is shared via context so the price table
  // swaps to the toggled member's pricing rule + variant in parallel.
  const { activeMember, isViewingCurrent, setActiveMemberId } = useActiveMember(data);
  const activeMemberId = activeMember?.member_id || null;

  // When viewing the CURRENT product, use its full multi-image gallery.
  // When viewing a linked member, fall back to that member's single hero
  // (we don't pre-load every linked product's whole gallery — phase 1).
  const visibleGallery: MediaItem[] = isViewingCurrent || !activeMember
    ? heroGallery
    : [{
        slot: "hero",
        url: activeMember.hero_url,
        webp_url: activeMember.hero_webp_url,
        avif_url: activeMember.hero_avif_url,
        avif_480_url: null, webp_480_url: null,
        avif_750_url: null, webp_750_url: null,
        avif_1080_url: null, webp_1080_url: null,
        avif_1500_url: null, webp_1500_url: null,
        avif_1920_url: null, webp_1920_url: null,
        alt_text: activeMember.product_title,
        width: activeMember.hero_width,
        height: activeMember.hero_height,
      }];

  // Servings chip text for the active member (e.g. "30 Servings", "24 Pods")
  const servings = activeMember?.primary_variant_servings;
  const servingsUnit = activeMember?.primary_variant_servings_unit;
  const servingsLabel = servings != null ? `${servings} ${servingsUnit || "Servings"}` : null;

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

  // The price table now updates in-place when the hero toggle
  // changes (via shared active-member context), so the CTA always
  // scrolls down to pricing — no need to bounce the customer to a
  // sibling product's URL just to show its pricing.
  void pathname;
  // Bundle mode wires the hero CTA straight to add-to-cart on the base variant (placeholder for the
  // Starter Kit variant, per the offer-creator spec) instead of scrolling to a price table.
  const bundleVariantId = bundle ? data.base_variant?.id || null : null;
  const bundleFreqs = data.pricing_rule?.available_frequencies || [];
  const bundleFreq = bundleFreqs.find((f) => f.default) || bundleFreqs[0] || null;
  const ctaHref = bundleVariantId ? `#buy-${bundleVariantId}` : "#pricing";

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
  //
  // The 90vw cap is applied via Tailwind arbitrary value at xl: only —
  // on mobile/tablet, gutters come from `px-5` on the container so they
  // match the rest of the page (e.g. "Why this works" section also at
  // px-5). Without the xl: scope, mobile gutters would compound: 5vw
  // from the cap + 20px from the text column's own px-5 = ~40px gutter
  // for text but ~20px for the image, which read as inconsistent.
  const containerStyle: React.CSSProperties = {
    "--hero-aspect-w": String(heroAspectW),
    "--hero-aspect-h": String(heroAspectH),
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
        className="mx-auto flex w-full flex-col xl:flex-row xl:items-start xl:gap-10 xl:px-10 xl:[max-width:min(2400px,90vw)]"
      >
        {/* Hero image — sticky on desktop, top-aligned. Mobile + tablet
            (incl. iPad Pro portrait) keep stacked 4:3 + object-cover
            since the side-by-side layout cramps the text column below
            ~1280px. Side-by-side kicks in at xl: (1280px+) where
            there's room for the image to have wow factor without
            squeezing the headline.
            Edge-to-edge on mobile/tablet (no px-5 here) for dramatic
            effect — the text column adds its own px-5 below. */}
        <div className="relative w-full xl:order-1 xl:basis-3/5 xl:sticky xl:top-0 xl:flex xl:h-screen xl:flex-col xl:items-stretch xl:pt-8">
          <HeroGallery
            items={visibleGallery}
            altFallback={activeMember?.product_title || heroAlt}
            isBestseller={!!data.product.is_bestseller}
            aspectW={heroAspectW}
            aspectH={heroAspectH}
            supplementFacts={(() => {
              // Show the active product's first variant with facts as
              // the hero's facts slide. Active product = current product
              // unless the format toggle is on a linked sibling.
              const activeProductId =
                activeMember && !activeMember.is_current
                  ? activeMember.product_id
                  : data.product.id;
              const v = (data.variants_with_facts || []).find(
                (x) => x.product_id === activeProductId,
              );
              return v?.supplement_facts || null;
            })()}
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
          <p className="storefront-display mt-2 text-[28px] font-bold leading-[1.2] tracking-tight text-zinc-900 sm:text-4xl md:text-5xl">
            {headline}
          </p>

          {subhead && (
            <p className="mt-3 max-w-xl text-lg leading-relaxed text-zinc-800 sm:text-xl">
              {subhead}
            </p>
          )}

          {/* "As Seen On" press row — placed high (right under the headline)
              so the trust signal lands before the fold on mobile and desktop. */}
          <div className="mt-5">
            <PressLogos media={data.media_by_slot} label="As Seen On" align="center" />
          </div>

          {(data.product.awards || []).length > 0 && (
            <div className="mt-4">
              <PressQuote items={data.product.awards} variant="light" />
            </div>
          )}

          {!bundle && linkGroup && sortedMembers.length > 1 && (
            <div className="mt-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                  {linkGroup.name}
                </span>
                {servingsLabel && (
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-700">
                    {servingsLabel}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {sortedMembers.map((m) => {
                  const isActive = m.member_id === activeMemberId;
                  return (
                    <button
                      key={m.member_id}
                      type="button"
                      onClick={() => setActiveMemberId(m.member_id)}
                      aria-pressed={isActive}
                      style={
                        isActive
                          ? {
                              backgroundColor: "var(--storefront-primary)",
                              borderColor: "var(--storefront-primary)",
                            }
                          : undefined
                      }
                      className={`rounded-full border-2 px-4 py-2 text-sm font-semibold transition-colors ${
                        isActive
                          ? "text-white"
                          : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-400"
                      }`}
                    >
                      {m.value}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {benefitBar.length > 0 && (
            <>
              {/* Problem/solution lead-in — frames the benefits as the answer
                  to a real pain instead of an unprompted feature list. */}
              {data.page_content?.benefit_bar_intro && (
                <div className="mt-6">
                  <p className="text-lg font-extrabold leading-snug text-zinc-900 sm:text-xl">
                    {data.page_content.benefit_bar_intro}
                  </p>
                  {data.page_content.benefit_bar_transition && (
                    <p className="mt-1.5 text-sm font-medium text-zinc-500">
                      {data.page_content.benefit_bar_transition}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {benefitBar.slice(0, 4).map((b, i) => (
                  <BenefitChip key={i} label={b.text} index={i} />
                ))}
              </div>
              <ResearchCredibility data={data} />
            </>
          )}

          {data.reviews.length > 0 && (
            <div className="mt-6">
              <HeroFeaturedReviews
                reviews={data.reviews}
                workspaceSlug={data.workspace.storefront_slug || undefined}
                slug={data.product.handle}
              />
            </div>
          )}

          <div className="mt-6">
            <ShopCTA
              href={ctaHref}
              label={bundle ? "Select Bundle" : !isViewingCurrent && activeMember ? `Shop ${activeMember.value}` : undefined}
              lowestPriceCents={lowestPrice}
              align="center"
              dataAttributes={
                bundleVariantId
                  ? { "variant-id": bundleVariantId, "tier-quantity": 1, mode: "subscribe", "frequency-days": bundleFreq?.interval_days ?? null }
                  : undefined
              }
            />
          </div>

          {((data.product.certifications || []).length > 0 ||
            (data.product.allergen_free || []).length > 0) && (
            <div className="mt-5">
              <TrustChipRow
                certifications={data.product.certifications}
                allergenFree={data.product.allergen_free}
                align="center"
              />
            </div>
          )}

        </div>
      </div>
    </section>
  );
}

/**
 * Is `name` a "caffeine-style duplicate" of an ingredient already in the
 * list? A caffeine card that parenthetically sources an existing superfood
 * (e.g. "100mg Caffeine (Green Tea)" when "Green Tea" is its own card) is the
 * SAME superfood surfaced twice — it inflates the count. We detect it (mentions
 * caffeine + parenthetically references another listed ingredient) so it isn't
 * double-counted. The card itself is kept; only the credibility COUNT excludes it.
 */
function isCaffeineDuplicate(name: string, allNames: string[]): boolean {
  const lower = name.toLowerCase();
  if (!lower.includes("caffeine")) return false;
  const paren = name.match(/\(([^)]+)\)/);
  if (!paren) return false;
  const ref = paren[1].trim().toLowerCase();
  if (!ref) return false;
  return allNames.some((other) => {
    const o = other.toLowerCase();
    if (o === lower) return false;
    return o.includes(ref) || ref.includes(o);
  });
}

/** Count distinct superfoods, collapsing caffeine-style duplicates (16 → 15). */
export function countDistinctSuperfoods(names: string[]): number {
  return names.filter((n) => !isCaffeineDuplicate(n, names)).length;
}

/**
 * "Backed by N studies on M superfoods in {product}" — the credibility
 * tag that sits under the benefit cards. Numbers come straight from the
 * ingredient_research rows we already loaded for this page; the superfood
 * count excludes caffeine-style duplicates of an existing ingredient (so the
 * Tabs "100mg caffeine (green tea)" card, which duplicates Green Tea, counts
 * once → 15 not 16). Rendering is suppressed when there's nothing to claim.
 */
function ResearchCredibility({ data }: { data: PageData }) {
  // Count total citations across every ingredient's research rows.
  const studyCount = data.ingredient_research.reduce((sum, r) => {
    return sum + (Array.isArray(r.citations) ? r.citations.length : 0);
  }, 0);

  // Distinct superfoods that actually have research attached — not the raw
  // ingredient list (some may be supporting / unstudied), and collapsing
  // caffeine-style duplicates of an existing ingredient so we don't claim
  // one superfood twice.
  const allNames = data.ingredients.map((i) => i.name);
  const researchedIds = new Set(data.ingredient_research.map((r) => r.ingredient_id));
  const researchedNames = data.ingredients
    .filter((i) => researchedIds.has(i.id))
    .map((i) => i.name);
  const ingredientCount = researchedNames.filter(
    (n) => !isCaffeineDuplicate(n, allNames),
  ).length;

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
        <span className="font-bold text-zinc-900">{ingredientCount} superfoods</span> in {data.product.title}
      </span>
    </p>
  );
}
