/**
 * Upsell complementarity chapter — pre-sells the bundle partner
 * product between the primary product's chapters and the price
 * tables. Lightweight on purpose: it should set up the bundle pitch
 * without competing with the primary product's storyline.
 *
 * Visual treatment matches the rest of the storefront chapters:
 * white background, dark text, primary-color CTA — consistent with
 * the other chapters so the section reads as part of the same page,
 * not a detour into the partner's brand world.
 *
 * Hero image is the partner product's lifestyle hero (from
 * product_media slot=hero), not a transparent-PNG bag visualization
 * — the bag visualization lives in the bundle price table below.
 *
 * Renders only when:
 *   - data.upsell.complementarity is populated, AND
 *   - data.upsell.hero_image_url is available.
 */
import type { PageData } from "../_lib/page-data";
import { TrustChipRow } from "../_components/TrustChipRow";
import { ShopCTA } from "../_components/ShopCTA";
import { ExpandableReviewCard } from "../_components/ExpandableReviewCard";

export function UpsellChapter({ data }: { data: PageData }) {
  const upsell = data.upsell;
  if (!upsell || !upsell.complementarity || !upsell.hero_image_url) return null;

  const { complementarity, product, reviews } = upsell;
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;

  const topReviews = reviews.slice(0, 2);

  return (
    <section
      data-section="upsell-chapter"
      className="w-full bg-white py-12 sm:py-16"
    >
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="grid gap-8 md:grid-cols-2 md:items-center md:gap-12">
          {/* Lifestyle hero of the partner product. Aspect-locked so
              layout doesn't shift while the image loads. */}
          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl bg-zinc-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={upsell.hero_image_url}
              alt={upsell.hero_image_alt || product.title}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Pairs with {data.product.title}
            </p>
            <h2
              className="font-bold text-3xl text-zinc-900 sm:text-4xl"
              style={{ fontFamily: "var(--storefront-heading-font)" }}
            >
              {complementarity.headline}
            </h2>
            <p className="mt-4 text-[17px] leading-relaxed text-zinc-700">
              {complementarity.intro}
            </p>

            <ul className="mt-5 space-y-2.5">
              {complementarity.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[16px] text-zinc-800">
                  <CheckIcon />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <TrustChipRow
              certifications={product.certifications}
              allergenFree={product.allergen_free}
              variant="light"
              align="start"
              className="mt-6"
            />
          </div>
        </div>

        {topReviews.length > 0 && (
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {topReviews.map((r) => (
              <ExpandableReviewCard
                key={r.id}
                id={r.id}
                body={r.body || ""}
                reviewerName={r.reviewer_name || "Verified customer"}
                rating={r.rating || 5}
                fgText="#18181b"
                fgMuted="rgba(24, 24, 27, 0.7)"
                cardBg="#ffffff"
                borderColor="rgba(24, 24, 27, 0.1)"
                linkColor="var(--storefront-primary)"
              />
            ))}
          </div>
        )}

        <div className="mt-10 flex justify-center">
          <ShopCTA
            href="#pricing"
            label="Bundle now and save"
            lowestPriceCents={lowestPrice}
            showTrust={false}
            align="center"
            variant="primary"
          />
        </div>
      </div>
    </section>
  );
}

function CheckIcon() {
  return (
    <svg
      className="mt-1 h-4 w-4 flex-shrink-0 text-emerald-600"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
