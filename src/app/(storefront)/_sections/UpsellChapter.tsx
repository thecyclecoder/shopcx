/**
 * Upsell complementarity chapter — pre-sells the bundle partner
 * product between the primary product's chapters and the price
 * tables. Lightweight on purpose: it should set up the bundle pitch
 * without competing with the primary product's storyline.
 *
 * Renders only when:
 *   - data.upsell.complementarity is populated (admin saved + AI
 *     generation completed), AND
 *   - data.upsell.hero_image_url is available (so the bag visual
 *     has something to render).
 *
 * Layout:
 *   - Left:  PackageStack visualization (single bag of the partner
 *            product's hero variant) wrapped in cream box.
 *   - Right: headline + intro + 3 bullets + trust chips. Up to 2 of
 *            the partner's featured reviews as small pull-quotes.
 *   - Below: ShopCTA scrolling to #pricing — same convention as the
 *            primary product chapters.
 */
import type { PageData } from "../_lib/page-data";
import { PackageStack } from "../_components/PackageStack";
import { TrustChipRow } from "../_components/TrustChipRow";
import { ShopCTA } from "../_components/ShopCTA";

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
      className="w-full bg-zinc-50 py-12 sm:py-16 dark:bg-zinc-900"
    >
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="grid gap-8 md:grid-cols-2 md:items-center md:gap-12">
          {/* Bag visualization — single bag in cream box, mirrors the
              primary product's hero treatment. */}
          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl">
            <PackageStack imageUrl={upsell.hero_image_url} count={1} />
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-500">
              Pairs with {product.title}
            </p>
            <h2 className="font-bold text-3xl sm:text-4xl text-zinc-900 dark:text-zinc-100"
                style={{ fontFamily: "var(--storefront-heading-font)" }}>
              {complementarity.headline}
            </h2>
            <p className="mt-4 text-[17px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {complementarity.intro}
            </p>

            <ul className="mt-5 space-y-2.5">
              {complementarity.bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5 text-[16px] text-zinc-800 dark:text-zinc-200">
                  <CheckIcon className="mt-1 h-4 w-4 flex-shrink-0 text-emerald-600" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <TrustChipRow
              certifications={product.certifications}
              allergenFree={product.allergen_free}
              align="start"
              className="mt-6"
            />
          </div>
        </div>

        {topReviews.length > 0 && (
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {topReviews.map((r) => {
              const quote = (r.smart_quote || r.body || "").trim();
              if (!quote) return null;
              const name = r.reviewer_name || "Verified customer";
              const rating = r.rating || 5;
              return (
                <figure
                  key={r.id}
                  className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-800"
                >
                  <Stars rating={rating} />
                  <blockquote className="mt-3 text-[16px] leading-relaxed text-zinc-800 dark:text-zinc-200">
                    &ldquo;{quote.length > 220 ? quote.slice(0, 220).trimEnd() + "…" : quote}&rdquo;
                  </blockquote>
                  <figcaption className="mt-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    — {name}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        )}

        <div className="mt-10 flex justify-center">
          <ShopCTA
            href="#pricing"
            label={`Bundle ${product.title} below`}
            lowestPriceCents={lowestPrice}
            showTrust={false}
            align="center"
          />
        </div>
      </div>
    </section>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
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

function Stars({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <div className="flex items-center gap-0.5 text-amber-400">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg key={i} width={14} height={14} viewBox="0 0 24 24" fill={i < filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.5}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </div>
  );
}
