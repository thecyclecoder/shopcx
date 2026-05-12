import type { PageData } from "../_lib/page-data";
import { Picture } from "../_components/PictureHero";

/**
 * Per-product nutritionist endorsement — quote + summary bullets +
 * avatar. Slot in the page flow after Ingredients and before the
 * What-to-expect timeline, so the customer reads science → expert
 * validates → expected journey.
 *
 * Mobile: avatar centered on top, name + title, quote, bullets stacked.
 * Desktop: 2-col grid. Left col = avatar + name + title + quote.
 *          Right col = bullets in a card.
 *
 * Renders nothing when name + quote are both missing.
 */
export function NutritionistEndorsementSection({ data }: { data: PageData }) {
  const pc = data.page_content;
  if (!pc) return null;
  const { endorsement_name: name, endorsement_title: title, endorsement_quote: quote, endorsement_bullets: bullets } = pc;
  if (!name && !quote && (bullets?.length || 0) === 0) return null;

  const avatar = data.media_by_slot["endorsement_avatar"] || null;

  return (
    <section data-section="endorsement" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="grid gap-8 md:grid-cols-2 md:items-start md:gap-12">
          {/* Left: avatar + identity + quote */}
          <div className="flex flex-col items-center text-center md:items-start md:text-left">
            <div
              className="relative h-24 w-24 overflow-hidden rounded-full ring-4 ring-zinc-100 sm:h-28 sm:w-28 md:h-32 md:w-32 [&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
              style={{ aspectRatio: "1 / 1" }}
            >
              <Picture
                media={avatar}
                altFallback={name || "Nutritionist"}
                sizes="(min-width: 768px) 128px, 96px"
                width={128}
                height={128}
              />
            </div>
            {name && (
              <div className="mt-4 text-lg font-bold text-zinc-900 sm:text-xl">
                {name}
              </div>
            )}
            {title && (
              <div className="text-sm font-medium uppercase tracking-wider text-zinc-500 sm:text-base">
                {title}
              </div>
            )}
            {quote && (
              <blockquote className="mt-5 text-lg italic leading-relaxed text-zinc-800 sm:text-xl md:mt-6">
                &ldquo;{quote}&rdquo;
              </blockquote>
            )}
          </div>

          {/* Right: bullet card */}
          {bullets && bullets.length > 0 && (
            <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-6 sm:p-7 md:p-8">
              <div className="text-sm font-bold uppercase tracking-wider text-zinc-500">
                Why it's recommended
              </div>
              <ul className="mt-4 space-y-3">
                {bullets.map((b, i) => (
                  <li key={i} className="flex items-start gap-3 text-base leading-relaxed text-zinc-800 sm:text-lg">
                    <span className="mt-1 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                    <span className="flex-1">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
