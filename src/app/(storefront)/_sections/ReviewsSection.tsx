"use client";

import { useCallback, useMemo, useState } from "react";
import type { PageData, Review } from "../_lib/page-data";
import { StarRating } from "../_components/StarRating";

/**
 * Full reviews list. Renders the first 6 server-side via the `data`
 * prop; "Load more" hits /api/storefront/[workspace]/[slug]/reviews.
 * Filter pills switch against the review body text (simple contains).
 */
export function ReviewsSection({
  data,
  workspaceSlug,
  slug,
}: {
  data: PageData;
  workspaceSlug: string;
  slug: string;
}) {
  const initial = data.reviews.slice(0, 6);
  const [reviews, setReviews] = useState<Review[]>(initial);
  const [offset, setOffset] = useState(initial.length);
  const [hasMore, setHasMore] = useState(data.review_total_count > initial.length);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  const availableFilters = useMemo(() => {
    const set = new Set<string>();
    for (const b of data.benefit_selections) {
      if (b.role === "lead" || b.role === "supporting") set.add(b.benefit_name);
    }
    return Array.from(set).slice(0, 6);
  }, [data.benefit_selections]);

  const filtered = useMemo(() => {
    if (!filter) return reviews;
    const needle = filter.toLowerCase();
    return reviews.filter((r) => (r.body || "").toLowerCase().includes(needle));
  }, [reviews, filter]);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/storefront/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(
          slug,
        )}/reviews?offset=${offset}&limit=12`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          reviews: Review[];
          has_more: boolean;
        };
        setReviews((prev) => [...prev, ...body.reviews]);
        setOffset((prev) => prev + body.reviews.length);
        setHasMore(body.has_more);
      }
    } catch {
      /* swallow — user can retry */
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, slug, offset]);

  if (initial.length === 0) return null;

  return (
    <section data-section="reviews" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <h2 className="mb-4 text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
          What customers are saying
        </h2>

        {data.product.rating != null && (
          <div className="mb-6 flex items-center gap-3">
            <StarRating rating={data.product.rating} size={20} />
            <span className="text-base text-zinc-700">
              <strong className="text-zinc-900">{data.product.rating.toFixed(1)}</strong>
              {" · "}
              {data.review_total_count.toLocaleString()} reviews
            </span>
          </div>
        )}

        {availableFilters.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setFilter(null)}
              className={`inline-flex min-h-[36px] items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === null
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-700"
              }`}
            >
              All reviews
            </button>
            {availableFilters.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(filter === f ? null : f)}
                className={`inline-flex min-h-[36px] items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
          {filtered.map((r) => (
            <article
              key={r.id}
              className="rounded-2xl border border-zinc-200 bg-white p-5"
            >
              <div className="flex items-center gap-2">
                <StarRating rating={r.rating ?? 5} size={16} />
                <span className="text-xs text-zinc-500">
                  {r.reviewer_name || "Verified buyer"}
                </span>
              </div>
              {r.title && (
                <h3 className="mt-2 text-base font-semibold text-zinc-900">{r.title}</h3>
              )}
              {r.body && (
                <p className="mt-2 whitespace-pre-line text-sm text-zinc-700">
                  {r.body}
                </p>
              )}
            </article>
          ))}
        </div>

        {filtered.length === 0 && (
          <p className="mt-4 text-sm text-zinc-500">No reviews match that filter.</p>
        )}

        {hasMore && !filter && (
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 bg-white px-6 text-sm font-semibold text-zinc-900 transition-colors hover:border-zinc-900 disabled:opacity-50"
            >
              {loading ? "Loading..." : "Load more reviews"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
