/**
 * Upsell complementarity chapter — pre-sells the bundle partner
 * product between the primary product's chapters and the price
 * tables. Lightweight on purpose: it should set up the bundle pitch
 * without competing with the primary product's storyline.
 *
 * Visual identity belongs to the PARTNER product, not the primary:
 *   - Section background uses the partner's `header_text_color` so the
 *     chapter visually reads as "this is the creamer's moment." Text
 *     and chip colors auto-invert to a light variant when the bg is
 *     dark (computed from the hex luminance).
 *   - Hero image is the partner product's lifestyle hero (from
 *     product_media slot=hero), not a transparent-PNG bag visualization
 *     — the bag visualization lives down in the bundle price table.
 *
 * Renders only when:
 *   - data.upsell.complementarity is populated, AND
 *   - data.upsell.hero_image_url is available.
 */
import type { PageData } from "../_lib/page-data";
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
  const bgColor = (product.header_text_color || "").trim() || "#fafaf9"; // zinc-50 fallback
  const isDark = isHexDark(bgColor);
  // Text color: cream-on-dark for dark bgs, near-black on light bgs.
  // Cream (#fef3c7 amber-100) reads warmer than plain white on most
  // dark brand colors and ties into the existing cream-box bag treatment.
  const fgText = isDark ? "#fef3c7" : "#18181b";
  const fgMuted = isDark ? "rgba(254, 243, 199, 0.75)" : "rgba(24, 24, 27, 0.7)";
  const accentBorder = isDark ? "rgba(254, 243, 199, 0.15)" : "rgba(24, 24, 27, 0.1)";
  const reviewCardBg = isDark ? "rgba(255, 255, 255, 0.08)" : "#ffffff";

  return (
    <section
      data-section="upsell-chapter"
      style={{ backgroundColor: bgColor, color: fgText }}
      className="w-full py-12 sm:py-16"
    >
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="grid gap-8 md:grid-cols-2 md:items-center md:gap-12">
          {/* Lifestyle hero image of the partner product. Aspect-locked
              so the layout doesn't shift while the image loads. */}
          <div className="aspect-[4/3] w-full overflow-hidden rounded-2xl bg-white/10">
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
            <p
              className="mb-2 text-xs font-semibold uppercase tracking-[0.18em]"
              style={{ color: fgMuted }}
            >
              Pairs with {data.product.title}
            </p>
            <h2
              className="font-bold text-3xl sm:text-4xl"
              style={{ fontFamily: "var(--storefront-heading-font)", color: fgText }}
            >
              {complementarity.headline}
            </h2>
            <p
              className="mt-4 text-[17px] leading-relaxed"
              style={{ color: isDark ? "rgba(254, 243, 199, 0.92)" : "rgba(24, 24, 27, 0.85)" }}
            >
              {complementarity.intro}
            </p>

            <ul className="mt-5 space-y-2.5">
              {complementarity.bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-[16px]"
                  style={{ color: fgText }}
                >
                  <CheckIcon
                    className="mt-1 h-4 w-4 flex-shrink-0"
                    color={isDark ? "#86efac" : "#059669"}
                  />
                  <span>{b}</span>
                </li>
              ))}
            </ul>

            <TrustChipRow
              certifications={product.certifications}
              allergenFree={product.allergen_free}
              variant={isDark ? "dark" : "light"}
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
                  className="rounded-2xl border p-5"
                  style={{
                    backgroundColor: reviewCardBg,
                    borderColor: accentBorder,
                  }}
                >
                  <Stars rating={rating} />
                  <blockquote
                    className="mt-3 text-[16px] leading-relaxed"
                    style={{ color: fgText }}
                  >
                    &ldquo;{quote.length > 220 ? quote.slice(0, 220).trimEnd() + "…" : quote}&rdquo;
                  </blockquote>
                  <figcaption
                    className="mt-3 text-xs font-semibold uppercase tracking-wider"
                    style={{ color: fgMuted }}
                  >
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
            variant={isDark ? "inverse" : "primary"}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Compute relative luminance of a hex color (#rrggbb or #rgb) using
 * the sRGB formula. Returns true when the color is "dark" enough that
 * white/cream text reads better than near-black. Threshold of 0.55 is
 * conservative — anything below that gets light text.
 */
function isHexDark(hex: string): boolean {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const sr = r <= 0.03928 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
  const sg = g <= 0.03928 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
  const sb = b <= 0.03928 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * sr + 0.7152 * sg + 0.0722 * sb;
  return luminance < 0.55;
}

function CheckIcon({ className = "", color = "#059669" }: { className?: string; color?: string }) {
  return (
    <svg
      className={className}
      style={{ color }}
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
