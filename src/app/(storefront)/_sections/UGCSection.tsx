import type { PageData, MediaItem } from "../_lib/page-data";
import { StarRating } from "../_components/StarRating";
import { ImageOrPlaceholder } from "../_components/ImageOrPlaceholder";

/**
 * Real-people UGC — photo reviews first, then featured reviews. Mobile
 * uses horizontal scroll-snap; md+ grid.
 */
export function UGCSection({ data }: { data: PageData }) {
  const ugcSlots = ["ugc_1", "ugc_2", "ugc_3", "ugc_4", "ugc_5", "ugc_6"];
  const ugcPhotos: MediaItem[] = ugcSlots
    .map((slot) => data.media_by_slot[slot])
    .filter((m): m is MediaItem => !!m && !!m.url);

  // Reviews with their own photos get priority; fall back to text-only
  // featured reviews.
  const photoReviews = data.reviews.filter(
    (r) => Array.isArray(r.images) && r.images.length > 0,
  );
  const featuredReviews = data.reviews
    .filter((r) => r.status === "featured" || (r.rating ?? 0) >= 5)
    .slice(0, 4);
  const picks = (photoReviews.length > 0 ? photoReviews : featuredReviews).slice(0, 6);

  if (ugcPhotos.length === 0 && picks.length === 0) return null;

  return (
    <section data-section="ugc" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <h2 className="mb-8 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          Real people, real results
        </h2>
      </div>

      {ugcPhotos.length > 0 && (
        <div className="mb-8 flex w-full snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-3 md:mx-auto md:max-w-6xl md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:px-8 lg:grid-cols-6">
          {ugcPhotos.map((photo) => (
            <div
              key={photo.slot}
              className="relative h-52 w-44 flex-shrink-0 snap-center overflow-hidden rounded-2xl md:h-auto md:w-auto"
              style={{ aspectRatio: "3 / 4" }}
            >
              <ImageOrPlaceholder
                src={photo.url}
                alt={photo.alt_text || "Customer photo"}
                fill
                sizes="(min-width: 768px) 200px, 180px"
                aspect="3/4"
                className="object-cover"
              />
            </div>
          ))}
        </div>
      )}

      {picks.length > 0 && (
        <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {picks.map((r) => (
              <blockquote
                key={r.id}
                className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5"
              >
                <StarRating rating={r.rating ?? 5} size={16} />
                {r.title && (
                  <div className="mt-2 text-base font-semibold text-zinc-900">
                    {r.title}
                  </div>
                )}
                {r.body && (
                  <p className="mt-2 line-clamp-5 text-sm leading-relaxed text-zinc-700">
                    {r.smart_quote || r.body}
                  </p>
                )}
                <footer className="mt-3 text-xs font-medium text-zinc-500">
                  — {r.reviewer_name || "Verified buyer"}
                </footer>
              </blockquote>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
