import type { PageData } from "../_lib/page-data";
import { Picture } from "../_components/PictureHero";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * "Why this works" — single-block section directly below the hero.
 *
 * Pulls the narrative copy from page_content.mechanism_copy and the
 * image from media_by_slot["lifestyle_1"]. The CTA jumps to the price
 * table on the same page.
 *
 * Mobile: title → image → copy → CTA (stacked).
 * Desktop (md+): title/copy/CTA on the left column, image on the right.
 *
 * Replaces the older numbered-steps treatment that read from
 * product_how_it_works — that table is now ignored. We also absorb
 * the standalone MechanismSection; render-page no longer renders it.
 */
export function HowItWorksSection({ data }: { data: PageData }) {
  const copy = data.page_content?.mechanism_copy;
  if (!copy) return null;

  const image = data.media_by_slot["lifestyle_1"] || null;
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(
        ...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents),
      )
    : null;

  const paragraphs = copy.split(/\n\n+/);

  return (
    <section data-section="why-this-works" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="flex flex-col gap-8 md:grid md:grid-cols-2 md:items-center md:gap-12">
          {/* Title (mobile only — appears first per spec) */}
          <h2 className="text-center text-2xl font-bold leading-tight tracking-tight text-zinc-900 sm:text-3xl md:hidden">
            Why this works
          </h2>

          {/* Image — second on mobile, right column on desktop */}
          <div className="md:order-2">
            <Picture
              media={image}
              altFallback={`${data.product.title} lifestyle`}
              sizes="(min-width: 768px) 50vw, 100vw"
              width={image?.width || 800}
              height={image?.height || 600}
              className="h-auto w-full rounded-2xl object-cover"
            />
          </div>

          {/* Copy + CTA — third on mobile, left column on desktop */}
          <div className="md:order-1">
            {/* Title (desktop only — same H2, just position-controlled) */}
            <h2 className="hidden text-3xl font-bold leading-tight tracking-tight text-zinc-900 md:block md:text-4xl">
              Why this works
            </h2>
            <div className="space-y-4 text-zinc-700 md:mt-5">
              {paragraphs.map((para, i) => (
                <p key={i} className="text-lg leading-relaxed text-zinc-800">
                  {para}
                </p>
              ))}
            </div>
            <div className="mt-6 md:mt-8">
              <ShopCTA lowestPriceCents={lowestPrice} align="start" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
