import type { PageData } from "../_lib/page-data";
import { StarRating } from "../_components/StarRating";
import { BeforeAfterPair } from "../_components/BeforeAfterPair";
import { ExpandableReviewBody } from "../_components/ExpandableReviewBody";

/**
 * Real people, real results — featured reviews + before/after pair.
 *
 * Pulls EXCLUSIVELY from hand-picked featured reviews (these are the
 * strongest weight-loss stories). If you add a before image + after
 * image in the dashboard, they render side-by-side as a transformation
 * pair above the reviews (mobile) or beside them (desktop).
 *
 * Mobile layout: title → before/after → reviews stacked.
 * Desktop layout: title → 2-col grid: before/after on the left,
 *                 first 2-3 featured reviews stacked on the right.
 *                 If more featured reviews exist, a 3-col grid below.
 */
export function UGCSection({ data }: { data: PageData }) {
  const beforeImg = data.media_by_slot["before"] || null;
  const afterImg = data.media_by_slot["after"] || null;
  const hasPair = !!(beforeImg && afterImg);

  // Featured-only — the admin-curated transformation stories.
  // Cap at 8: 2 alongside the before/after, then 2 rows of 3 below.
  // Section keeps a tight social-proof beat without becoming a wall.
  const allFeatured = data.reviews.filter((r) => r.status === "featured" || r.featured === true);
  const featured = allFeatured.slice(0, 8);

  if (!hasPair && featured.length === 0) return null;

  // Split: first 2 sit alongside the before/after on desktop, the
  // remaining 6 flow into a 3-col grid below.
  const sideBySideCount = hasPair ? 2 : 0;
  const sideReviews = featured.slice(0, sideBySideCount);
  const restReviews = featured.slice(sideBySideCount);

  return (
    <section data-section="ugc" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:mb-10 md:text-left md:text-4xl">
          Real people, real results
        </h2>

        {hasPair ? (
          <div className="grid gap-8 md:grid-cols-2 md:items-start md:gap-10">
            <div>
              <BeforeAfterPair before={beforeImg} after={afterImg} />
            </div>
            <div className="grid gap-4">
              {sideReviews.length > 0
                ? sideReviews.map((r) => <ReviewCard key={r.id} review={r} />)
                : restReviews.slice(0, 2).map((r) => <ReviewCard key={r.id} review={r} />)
              }
            </div>
          </div>
        ) : null}

        {restReviews.length > 0 && (
          <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${hasPair ? "mt-8 md:mt-12" : ""}`}>
            {(hasPair ? restReviews : featured).map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewCard({ review: r }: { review: PageData["reviews"][number] }) {
  // Prefer the full body for the in-place expand. smart_quote is a
  // shortened pull-quote used when we have no length constraint to
  // play with; here the body is line-clamped on render and the
  // ExpandableReviewBody handles the rest.
  const text = r.body || r.smart_quote || "";
  return (
    <blockquote className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5">
      <StarRating rating={r.rating ?? 5} size={16} />
      {r.title && (
        <div className="mt-2 text-base font-semibold text-zinc-900">
          {r.title}
        </div>
      )}
      {text && <ExpandableReviewBody text={text} />}
      <footer className="mt-3 text-xs font-medium text-zinc-500">
        — {r.reviewer_name || "Verified buyer"}
      </footer>
    </blockquote>
  );
}
