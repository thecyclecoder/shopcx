import type { PageData } from "../_lib/page-data";
import type { AdvertorialContent } from "@/lib/advertorial-pages";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Advertorial lander hero — the editorial "article" top that matches the
 * advertorial ad (serif masthead, real-person/ingredient hero, SPONSORED label).
 * Deliberately NOT the branded PDP hero: the un-ad, looks-like-content register is
 * the whole point of the lander (it's why the cold-50+ click doesn't bounce).
 *
 * Everything below this (chapter → ingredients → pricing → reviews → checkout) is
 * the existing PDP reused unchanged. data-section makes it auto-instrumented by
 * StorefrontChapterTracker. See docs/brain/specs/advertorial-landers.md.
 */
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";

function Stars({ n }: { n: number }) {
  const full = Math.max(0, Math.min(5, Math.round(n)));
  return (
    <span aria-label={`${full} out of 5 stars`} style={{ color: "#E8A100", letterSpacing: 1 }}>
      {"★".repeat(full)}
      <span style={{ color: "#D8CFC4" }}>{"★".repeat(5 - full)}</span>
    </span>
  );
}

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

export function AdvertorialHero({ data, content }: { data: PageData; content: AdvertorialContent }) {
  const portrait = content.heroKind === "avatar";
  return (
    <section data-section="advertorial-hero" className="w-full bg-[#FBF8F2]">
      <div className="mx-auto max-w-3xl px-5 pt-6 pb-10 md:px-8">
        {/* Fake-magazine masthead is the ADVERTORIAL variant's "looks like an
            article" conversion mechanism. On the reasons listicle (and any other
            variant) it reads as cosplay, so it's hidden there — Dylan, 2026-06-16. */}
        {content.variant === "advertorial" && (
          <>
            {/* Masthead — brand-owned, never impersonates a real outlet. Stacked so
                the serif title can't collide with the tags on narrow screens. */}
            <div className="border-b-2 border-zinc-900 pb-3">
              <div className="flex items-center justify-between">
                <span className="rounded bg-zinc-900 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#FBF8F2] sm:text-[11px]">
                  {content.sponsorLabel}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest sm:text-[11px]" style={{ color: "var(--storefront-accent)" }}>
                  Health
                </span>
              </div>
              <div
                style={{ fontFamily: SERIF }}
                className="mt-2 text-center text-xl font-black uppercase tracking-wide text-zinc-900 sm:text-3xl"
              >
                {content.publication}
              </div>
            </div>

            <div className="mt-3 text-sm font-medium text-zinc-500">By the Editorial Team</div>
          </>
        )}

        <h1
          style={{ fontFamily: SERIF }}
          className="mt-3 text-[2rem] font-black leading-[1.06] tracking-tight text-zinc-900 sm:text-5xl"
        >
          {content.headline}
        </h1>
        {content.dek && (
          <p className="mt-4 text-lg leading-snug text-zinc-700 sm:text-xl">{content.dek}</p>
        )}

        {content.heroImageUrl && (
          <figure className="mt-6">
            {/* Plain <img>: hero is a single signed ad-tool / public URL, not a
                responsive MediaItem. object-position top for tall avatar shots. */}
            <img
              src={content.heroImageUrl}
              alt={content.heroCaption || data.product.title}
              className="w-full rounded-2xl object-cover"
              style={{ aspectRatio: portrait ? "4 / 5" : "16 / 10", objectPosition: portrait ? "center top" : "center" }}
            />
            {content.heroCaption && (
              <figcaption className="mt-2 text-sm italic text-zinc-500">{content.heroCaption}</figcaption>
            )}
          </figure>
        )}

        <div className="mt-5 flex items-center gap-3 border-t border-zinc-200 pt-5">
          <Stars n={content.rating} />
          <span className="font-bold text-zinc-900">{content.rating.toFixed(1)}</span>
          <span className="text-sm text-zinc-500">from {content.reviewCountDisplay} verified reviews</span>
        </div>

        <div className="mt-7">
          <ShopCTA lowestPriceCents={lowestPriceCents(data)} align="start" />
        </div>
      </div>
    </section>
  );
}
