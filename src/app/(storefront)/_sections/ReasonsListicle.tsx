import type { PageData } from "../_lib/page-data";
import type { AdvertorialContent } from "@/lib/advertorial-pages";
import { ShopCTA } from "../_components/ShopCTA";

/**
 * "N reasons why" listicle body — the scent-match for the ingredient-breakdown ad
 * ("here's exactly what's inside / why it works"). A cold 50+ reader who clicked a
 * "the longer you drink it, the more it works" creative lands on a trustworthy
 * editorial listicle that enumerates the reasons, then drops into the existing PDP
 * closers (ingredients / pricing / reviews).
 *
 * Design: editorial serif, filled accent number badges, hairline dividers for
 * scannable rhythm, a section eyebrow, one CTA mid-list (so intent isn't held to
 * the end) + one after. Never a loud DTC wall — the un-ad look is the conversion
 * mechanism for this audience.
 */
const SERIF = "Georgia, 'Iowan Old Style', 'Palatino Linotype', 'Times New Roman', serif";

function lowestPriceCents(data: PageData): number | null {
  return data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;
}

export function ReasonsListicle({ data, content }: { data: PageData; content: AdvertorialContent }) {
  const reasons = (content.reasons || []).filter((r) => r.heading && r.body);
  if (!reasons.length) return null;
  const ctaAfter = Math.min(3, reasons.length - 1); // mid-list CTA while attention is high
  const price = lowestPriceCents(data);

  return (
    <section data-section="reasons-listicle" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-2xl px-5 md:px-8">
        <p
          className="text-center text-xs font-bold uppercase tracking-[0.2em]"
          style={{ color: "var(--storefront-accent)" }}
        >
          Why people are switching
        </p>
        <ol className="mt-9">
          {reasons.map((r, i) => (
            <li key={i}>
              <div className={`flex gap-5 ${i === 0 ? "" : "border-t border-zinc-200 pt-8"} ${i === reasons.length - 1 ? "" : "pb-8"}`}>
                {/* Filled accent badge — anchors each reason, scannable at a glance. */}
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl font-black tabular-nums text-white shadow-sm"
                  style={{ fontFamily: SERIF, backgroundColor: "var(--storefront-accent)" }}
                  aria-hidden
                >
                  {i + 1}
                </div>
                <div className="min-w-0 pt-1">
                  <h3 style={{ fontFamily: SERIF }} className="text-2xl font-black leading-snug tracking-tight text-zinc-900">
                    {r.heading}
                  </h3>
                  <p className="mt-2.5 text-lg leading-relaxed text-zinc-700">{r.body}</p>
                </div>
              </div>
              {i === ctaAfter && i !== reasons.length - 1 && (
                <div className="border-y border-zinc-200 py-8">
                  <ShopCTA lowestPriceCents={price} align="center" />
                </div>
              )}
            </li>
          ))}
        </ol>
        <div className="mt-12 rounded-2xl bg-zinc-50 p-7 text-center sm:p-9">
          <p style={{ fontFamily: SERIF }} className="text-xl font-black leading-snug text-zinc-900 sm:text-2xl">
            Ready to taste the difference?
          </p>
          <p className="mx-auto mt-2 max-w-md text-base leading-relaxed text-zinc-600">
            Join the people over 50 who made one simple swap to their morning.
          </p>
          <div className="mt-6">
            <ShopCTA lowestPriceCents={price} align="center" />
          </div>
        </div>
      </div>
    </section>
  );
}
