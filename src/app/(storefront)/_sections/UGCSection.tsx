"use client";

import { useEffect, useMemo, useState } from "react";
import type { PageData, Review, MediaItem, BeforeAfterStory } from "../_lib/page-data";
import { fetchReviewsBootstrap } from "../_lib/reviews-bootstrap-cache";
import { StarRating } from "../_components/StarRating";
import { BeforeAfterPair } from "../_components/BeforeAfterPair";
import { ExpandableReviewBody } from "../_components/ExpandableReviewBody";
import { ShopCTA } from "../_components/ShopCTA";

type Story = { before: MediaItem; after: MediaItem; testimonial: BeforeAfterStory | null };

/**
 * Real people, real results — featured reviews + before/after pair.
 *
 * Sources truly-featured reviews (Klaviyo smart_featured) only. On
 * mount, hits /reviews-bootstrap for a fresh featured pool and picks
 * a RANDOM subset for display, so multiple visits surface different
 * stories. SSG initial state is the legacy ordered list — used for
 * first paint while the bootstrap fetch is in flight.
 *
 * Mobile layout: title → before/after → reviews stacked.
 * Desktop layout: title → 2-col grid: before/after on the left,
 *                 first 2 featured reviews stacked on the right.
 *                 Remaining featured flow into a 3-col grid below.
 */
export function UGCSection({ data, workspaceSlug, slug }: {
  data: PageData;
  workspaceSlug: string;
  slug: string;
}) {
  // Up to 2 numbered before/after stories (before_1/after_1, before_2/after_2),
  // each with its own testimonial from page_content.before_after_stories. Falls
  // back to the legacy single before/after pair (Amazing Coffee) when no
  // numbered slots exist — that legacy pair still works, just unlabeled.
  const stories = useMemo<Story[]>(() => {
    const tales = data.page_content?.before_after_stories || [];
    const out: Story[] = [];
    for (let n = 1; n <= 2; n++) {
      const before = data.media_by_slot[`before_${n}`];
      const after = data.media_by_slot[`after_${n}`];
      if (before && after) out.push({ before, after, testimonial: tales[n - 1] || null });
    }
    if (out.length === 0) {
      const before = data.media_by_slot["before"];
      const after = data.media_by_slot["after"];
      if (before && after) out.push({ before, after, testimonial: tales[0] || null });
    }
    return out;
  }, [data.media_by_slot, data.page_content]);
  const hasPair = stories.length > 0;
  const lowestPrice = data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;

  // Initial state: featured reviews from the SSG payload. Replaced on
  // mount with a fresh fetch + random shuffle so visits surface
  // different stories.
  const initialFeatured = useMemo(
    () =>
      (data.reviews || []).filter(
        (r) => r.status === "featured" || r.featured === true,
      ),
    [data.reviews],
  );
  const [featuredPool, setFeaturedPool] = useState<Review[]>(initialFeatured);

  useEffect(() => {
    let abort = false;
    fetchReviewsBootstrap(workspaceSlug, slug)
      .then((body) => {
        if (abort) return;
        if (body.featured?.length) setFeaturedPool(body.featured);
      })
      .catch(() => {
        /* keep initial */
      });
    return () => {
      abort = true;
    };
  }, [workspaceSlug, slug]);

  // SSR rendered pool order vs client shuffle would diverge (server
  // Math.random ≠ client Math.random → React #418 hydration error).
  // Mirror HeroFeaturedReviews: render pool-order on first paint,
  // shuffle in useEffect AFTER mount so the customer still sees a
  // different order on each visit.
  const [featured, setFeatured] = useState<Review[]>(() => featuredPool.slice(0, 8));
  useEffect(() => {
    const arr = [...featuredPool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    setFeatured(arr.slice(0, 8));
  }, [featuredPool]);
  if (!hasPair && featured.length === 0) return null;

  // Each story sits beside its own testimonial. A story with no testimonial
  // (legacy single pair) borrows up to 2 featured reviews to fill the column;
  // whatever featured reviews aren't consumed flow into the grid below.
  let reviewCursor = 0;
  const storyBlocks = stories.map((s) => {
    if (s.testimonial) return { story: s, sideReviews: [] as Review[] };
    const take = featured.slice(reviewCursor, reviewCursor + 2);
    reviewCursor += take.length;
    return { story: s, sideReviews: take };
  });
  const restReviews = featured.slice(reviewCursor);

  return (
    <section data-section="ugc" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:mb-10 md:text-4xl">
          Real people, real results
        </h2>

        {storyBlocks.map(({ story: s, sideReviews }, i) => (
          <div
            key={i}
            className={`grid gap-8 md:grid-cols-2 md:items-start md:gap-10 ${i > 0 ? "mt-8 md:mt-12" : ""}`}
          >
            <div>
              <BeforeAfterPair
                before={s.before}
                after={s.after}
                altPrefix={s.testimonial?.name ? `${s.testimonial.name}'s transformation` : undefined}
              />
            </div>
            <div className="grid gap-4">
              {s.testimonial ? (
                <StoryTestimonial story={s.testimonial} />
              ) : (
                sideReviews.map((r) => <ReviewCard key={r.id} review={r} />)
              )}
            </div>
          </div>
        ))}

        {restReviews.length > 0 && (
          <div className={`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 ${hasPair ? "mt-8 md:mt-12" : ""}`}>
            {(hasPair ? restReviews : featured).map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
          </div>
        )}

        <div className="mt-10 flex justify-center md:mt-14">
          <ShopCTA lowestPriceCents={lowestPrice} align="center" />
        </div>
      </div>
    </section>
  );
}

/** The testimonial that accompanies one before/after transformation story. */
function StoryTestimonial({ story }: { story: BeforeAfterStory }) {
  return (
    <blockquote className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 sm:p-6">
      <StarRating rating={5} size={18} />
      {story.quote && <ExpandableReviewBody text={story.quote} />}
      <footer className="mt-4 text-sm font-medium text-zinc-600">
        — {story.name || "Verified buyer"}
        {story.variant ? <span className="text-zinc-400"> · {story.variant}</span> : null}
      </footer>
    </blockquote>
  );
}

function ReviewCard({ review: r }: { review: Review }) {
  const text = r.body || r.smart_quote || "";
  return (
    <blockquote className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 sm:p-6">
      <StarRating rating={r.rating ?? 5} size={18} />
      {r.title && (
        <div className="mt-3 text-lg font-bold text-zinc-900 sm:text-xl">
          {r.title}
        </div>
      )}
      {text && <ExpandableReviewBody text={text} />}
      <footer className="mt-4 text-sm font-medium text-zinc-600">
        — {r.reviewer_name || "Verified buyer"}
      </footer>
    </blockquote>
  );
}
