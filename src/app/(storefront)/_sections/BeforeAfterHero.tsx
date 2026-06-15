import type { PageData } from "../_lib/page-data";
import type { AdvertorialContent } from "@/lib/advertorial-pages";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Before/after lander hero — the transformation top that matches a before/after
 * ad (weight-loss angles). Real before/after `product_media`, framed exactly like
 * the ad, so the transformation scent the ad set up continues post-click. Followed
 * by a wall of weight-loss testimonials, then the existing PDP.
 *
 * Compliance: keep specific weight-loss NUMBERS out of the ad's own claims — those
 * live only in real testimonial quotes (the testimonial wall below).
 */
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

function Panel({ label, url, alt, tone }: { label: string; url: string | null; alt: string; tone: "before" | "after" }) {
  return (
    <div className="relative flex-1 overflow-hidden rounded-xl bg-zinc-200">
      {url ? (
        <img
          src={url}
          alt={alt}
          className="h-full w-full object-cover"
          style={{ aspectRatio: "3 / 4", filter: tone === "before" ? "grayscale(0.55) brightness(0.92)" : "none" }}
        />
      ) : (
        <div style={{ aspectRatio: "3 / 4" }} />
      )}
      <span
        className="absolute left-3 top-3 rounded px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-white"
        style={{ background: tone === "before" ? "#1A140F" : "var(--storefront-accent)" }}
      >
        {label}
      </span>
    </div>
  );
}

export function BeforeAfterHero({ data, content }: { data: PageData; content: AdvertorialContent }) {
  return (
    <section data-section="beforeafter-hero" className="w-full bg-[#FBF8F2] py-8 sm:py-12">
      <div className="mx-auto max-w-2xl px-5 text-center md:px-8">
        <span className="inline-block rounded bg-zinc-900 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-[#FBF8F2]">
          {content.sponsorLabel}
        </span>
        <h1 style={{ fontFamily: SERIF }} className="mt-4 text-[1.9rem] font-black leading-[1.08] tracking-tight text-zinc-900 sm:text-4xl">
          {content.headline}
        </h1>
        {content.dek && <p className="mt-3 text-lg text-zinc-700">{content.dek}</p>}

        <div className="mt-6 flex gap-3">
          <Panel label="Before" url={content.beforeImageUrl} alt="Before" tone="before" />
          <Panel label="After" url={content.afterImageUrl} alt="After" tone="after" />
        </div>
        {content.heroCaption && <p className="mt-3 text-sm italic text-zinc-500">{content.heroCaption}</p>}

        <div className="mt-8 flex justify-center">
          <ShopCTA lowestPriceCents={lowestPriceCents(data)} align="center" />
        </div>
      </div>
    </section>
  );
}
