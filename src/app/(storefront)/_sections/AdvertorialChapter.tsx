import type { PageData } from "../_lib/page-data";
import type { AdvertorialContent } from "@/lib/advertorial-pages";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * Advertorial narrative chapter 1 (problem → mechanism/story → proof) — the one
 * piece of generated long-form on the lander. This is the section that fights the
 * 86%→24% hero cliff: it carries the reader from the editorial hero into the
 * existing PDP closers (ingredients / pricing). Routes narrative INTO the starved
 * high-converting chapters rather than the dead mid-chapters.
 */
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

export function AdvertorialChapter({ data, content }: { data: PageData; content: AdvertorialContent }) {
  const paragraphs = content.chapter.paragraphs.filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <section data-section="advertorial-chapter" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-2xl px-5 md:px-8">
        <h2 style={{ fontFamily: SERIF }} className="text-2xl font-black leading-tight tracking-tight text-zinc-900 sm:text-3xl">
          {content.chapter.heading}
        </h2>
        <div className="mt-5 space-y-5">
          {paragraphs.map((para, i) => (
            <p key={i} className="text-lg leading-relaxed text-zinc-800">
              {/* Drop cap on the opening paragraph reinforces the editorial feel. */}
              {i === 0 ? (
                <>
                  <span style={{ fontFamily: SERIF, color: "var(--storefront-accent)" }} className="float-left mr-2 mt-1 text-6xl font-black leading-[0.8]">
                    {para.charAt(0)}
                  </span>
                  {para.slice(1)}
                </>
              ) : (
                para
              )}
            </p>
          ))}
        </div>
        <div className="mt-8">
          <ShopCTA lowestPriceCents={lowestPriceCents(data)} align="start" />
        </div>
      </div>
    </section>
  );
}
