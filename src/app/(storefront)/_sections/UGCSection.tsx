"use client";

import { useEffect, useMemo, useState } from "react";
import type { PageData, Review } from "../_lib/page-data";
import { fetchReviewsBootstrap } from "../_lib/reviews-bootstrap-cache";
import { StarRating } from "../_components/StarRating";
import { BeforeAfterPair } from "../_components/BeforeAfterPair";
import { ExpandableReviewBody } from "../_components/ExpandableReviewBody";

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
  const beforeImg = data.media_by_slot["before"] || null;
  const afterImg = data.media_by_slot["after"] || null;
  const hasPair = !!(beforeImg && afterImg);

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

  // Random shuffle on every mount — same pool, different order each
  // visit. Memo guard keeps the order stable through interactions
  // (expand toggles, etc.) instead of jumping on every render.
  const shuffled = useMemo(() => {
    const arr = [...featuredPool];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, 8);
  }, [featuredPool]);

  const featured = shuffled;
  if (!hasPair && featured.length === 0) return null;

  const sideBySideCount = hasPair ? 2 : 0;
  const sideReviews = featured.slice(0, sideBySideCount);
  const restReviews = featured.slice(sideBySideCount);

  return (
    <section data-section="ugc" className="w-full bg-white py-12 sm:py-16">
      <div className="mx-auto w-full max-w-6xl px-5 md:px-8">
        <h2 className="mb-8 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:mb-10 md:text-4xl">
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
