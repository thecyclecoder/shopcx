import type { PageData, MediaItem } from "../_lib/page-data";
import { Picture } from "../_components/PictureHero";

/**
 * Per-product nutritionist endorsements — up to 3 expert cards rendered
 * side-by-side. Each card has an avatar, name, title, quote, and a
 * short check-bullet list of why they recommend the product.
 *
 * Avatars live in product_media at slots `endorsement_1_avatar`,
 * `endorsement_2_avatar`, `endorsement_3_avatar` (1-indexed to match
 * the visible ordering).
 *
 * Mobile: cards stacked vertically.
 * Desktop: 3-col grid.
 *
 * Renders nothing when no endorsements exist.
 */
export function NutritionistEndorsementSection({ data }: { data: PageData }) {
  const endorsements = data.page_content?.endorsements || [];
  if (endorsements.length === 0) return null;

  // Cap at 3 — the grid is sized for that and more would crowd the
  // section. Admins can rearrange order in the dashboard.
  const cards = endorsements.slice(0, 3);

  return (
    <section data-section="endorsement" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="mb-8 text-center md:mb-10">
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
            Recommended by nutritionists
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-zinc-700 sm:text-lg">
            Independent experts who reviewed the formula and stand behind it.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3 md:gap-6">
          {cards.map((e, i) => (
            <EndorsementCard
              key={i}
              avatar={data.media_by_slot[`endorsement_${i + 1}_avatar`] || null}
              name={e.name}
              title={e.title}
              quote={e.quote}
              bullets={e.bullets || []}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function EndorsementCard({
  avatar,
  name,
  title,
  quote,
  bullets,
}: {
  avatar: MediaItem | null;
  name: string;
  title: string;
  quote: string;
  bullets: string[];
}) {
  return (
    <article className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-zinc-50 p-6 sm:p-7">
      <div className="flex items-center gap-4">
        <div
          className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-full ring-4 ring-white shadow-sm sm:h-20 sm:w-20 [&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
          style={{ aspectRatio: "1 / 1" }}
        >
          <Picture
            media={avatar}
            altFallback={name || "Nutritionist"}
            sizes="(min-width: 640px) 80px, 64px"
            width={80}
            height={80}
          />
        </div>
        <div className="flex-1 min-w-0">
          {name && (
            <div className="text-base font-bold text-zinc-900 sm:text-lg">{name}</div>
          )}
          {title && (
            <div className="text-xs font-medium uppercase tracking-wider text-zinc-500 sm:text-sm">
              {title}
            </div>
          )}
        </div>
      </div>

      {quote && (
        <blockquote className="mt-5 text-base italic leading-relaxed text-zinc-800 sm:text-lg">
          &ldquo;{quote}&rdquo;
        </blockquote>
      )}

      {bullets.length > 0 && (
        <ul className="mt-5 space-y-2.5">
          {bullets.map((b, i) => (
            <li
              key={i}
              className="flex items-start gap-2.5 text-sm leading-relaxed text-zinc-800 sm:text-base"
            >
              <span className="mt-1 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
              <span className="flex-1">{b}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
