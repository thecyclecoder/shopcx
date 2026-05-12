/**
 * In-flight request dedupe + short TTL cache for /reviews-bootstrap.
 *
 * Multiple components (HeroFeaturedReviews, UGCSection, ReviewsSection)
 * all need the bootstrap payload on mount. Without this, each makes its
 * own fetch and they race against the same edge cache. With this, the
 * first caller starts the fetch, the rest get the same promise.
 *
 * TTL matches the endpoint's 60s s-maxage so we don't re-fetch while
 * the edge cache is still warm — saves an extra round-trip on
 * page-to-page navigation within a session.
 */

import type { Review } from "./page-data";

export interface ReviewsBootstrap {
  featured: Review[];
  recent: Review[];
  total: number;
  benefit_review_matches: Record<string, string[]>;
}

const cache = new Map<string, { promise: Promise<ReviewsBootstrap>; expires: number }>();
const TTL_MS = 60_000;

export function fetchReviewsBootstrap(
  workspaceSlug: string,
  slug: string,
): Promise<ReviewsBootstrap> {
  const key = `${workspaceSlug}/${slug}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.promise;

  const promise = fetch(
    `/api/storefront/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(slug)}/reviews-bootstrap`,
  )
    .then((res) => {
      if (!res.ok) throw new Error(`reviews-bootstrap ${res.status}`);
      return res.json() as Promise<ReviewsBootstrap>;
    })
    .catch((err) => {
      // Evict on error so a retry can happen sooner.
      cache.delete(key);
      throw err;
    });

  cache.set(key, { promise, expires: now + TTL_MS });
  return promise;
}
