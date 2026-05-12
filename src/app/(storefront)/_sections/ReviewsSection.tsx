"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { PageData, Review } from "../_lib/page-data";
import { fetchReviewsBootstrap } from "../_lib/reviews-bootstrap-cache";
import { StarRating } from "../_components/StarRating";

/**
 * Full reviews list with benefit-pill filters.
 *
 * On mount, hits /reviews-bootstrap to pull a fresh slice of reviews
 * + the benefit→review-id matches map (computed server-side across
 * the full linked-product corpus). Initial SSG data is shown for the
 * first paint / SEO; mount swaps in the freshest set so customers
 * always see new reviews without waiting on ISR.
 *
 * Pill clicks: intersect with the loaded set first; if more matches
 * exist than loaded, lazy-fetch the missing IDs and merge into state.
 * Pills with zero matches are hidden — never a broken filter.
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
  const initial = data.reviews.slice(0, 30);
  const [reviews, setReviews] = useState<Review[]>(initial);
  const [matches, setMatches] = useState<Record<string, string[]>>(
    data.benefit_review_matches || {},
  );
  const [total, setTotal] = useState(data.review_total_count);
  const [offset, setOffset] = useState(initial.length);
  const [loading, setLoading] = useState(false);
  const [pillLoading, setPillLoading] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);

  // Refresh on mount so new reviews + featured updates appear without
  // an ISR cycle. We replace state outright when the server returns —
  // the SSG version stays visible until then for instant LCP. Shared
  // cache dedupes parallel fetches from sibling sections.
  useEffect(() => {
    let abort = false;
    fetchReviewsBootstrap(workspaceSlug, slug)
      .then((body) => {
        if (abort) return;
        setReviews(body.recent || []);
        setMatches(body.benefit_review_matches || {});
        setTotal(body.total || 0);
        setOffset((body.recent || []).length);
      })
      .catch(() => {
        /* keep SSG data on failure */
      });
    return () => {
      abort = true;
    };
  }, [workspaceSlug, slug]);

  const availableFilters = useMemo(() => {
    return data.benefit_selections
      .filter(
        (b) =>
          (b.role === "lead" || b.role === "supporting") &&
          (matches[b.benefit_name]?.length || 0) > 0,
      )
      .map((b) => b.benefit_name)
      .slice(0, 6);
  }, [data.benefit_selections, matches]);

  // For active filter, derive the shown reviews from the matched IDs
  // intersected with what we have loaded. If the filter has matches we
  // haven't fetched yet, the effect below lazy-loads them.
  const loadedById = useMemo(() => {
    const m = new Map<string, Review>();
    for (const r of reviews) m.set(r.id, r);
    return m;
  }, [reviews]);

  const filtered = useMemo(() => {
    if (!filter) return reviews;
    const ids = matches[filter] || [];
    const result: Review[] = [];
    for (const id of ids) {
      const r = loadedById.get(id);
      if (r) result.push(r);
    }
    return result;
  }, [filter, matches, loadedById, reviews]);

  // Lazy-fetch missing matched reviews when a filter is selected.
  useEffect(() => {
    if (!filter) return;
    const ids = matches[filter] || [];
    if (ids.length === 0) return;
    const missing = ids.filter((id) => !loadedById.has(id)).slice(0, 50);
    if (missing.length === 0) return;
    let abort = false;
    setPillLoading(true);
    (async () => {
      try {
        const res = await fetch(
          `/api/storefront/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(slug)}/reviews?ids=${encodeURIComponent(missing.join(","))}`,
        );
        if (!res.ok || abort) return;
        const body = (await res.json()) as { reviews: Review[] };
        if (body.reviews?.length) {
          setReviews((prev) => {
            const seen = new Set(prev.map((r) => r.id));
            const fresh = body.reviews.filter((r) => !seen.has(r.id));
            return [...prev, ...fresh];
          });
        }
      } catch {
        /* swallow */
      } finally {
        if (!abort) setPillLoading(false);
      }
    })();
    return () => {
      abort = true;
    };
  }, [filter, matches, loadedById, workspaceSlug, slug]);

  const loadMore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/storefront/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(slug)}/reviews?offset=${offset}&limit=12`,
      );
      if (res.ok) {
        const body = (await res.json()) as {
          reviews: Review[];
          total: number;
          has_more: boolean;
        };
        setReviews((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          const fresh = body.reviews.filter((r) => !seen.has(r.id));
          return [...prev, ...fresh];
        });
        setOffset((prev) => prev + body.reviews.length);
        setTotal(body.total || total);
      }
    } catch {
      /* swallow */
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, slug, offset, total]);

  const hasMore = !filter && reviews.length < total;
  if (initial.length === 0) return null;

  return (
    <section data-section="reviews" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto w-full max-w-5xl px-5 md:px-8">
        <h2 className="mb-4 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-left md:text-4xl">
          What customers are saying
        </h2>

        {data.product.rating != null && (
          <div className="mb-6 flex items-center gap-3">
            <StarRating rating={data.product.rating} size={20} />
            <span className="text-base text-zinc-700">
              <strong className="text-zinc-900">{data.product.rating.toFixed(1)}</strong>
              {" · "}
              {total.toLocaleString()} reviews
            </span>
          </div>
        )}

        {availableFilters.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setFilter(null)}
              style={filter === null ? { backgroundColor: "var(--storefront-primary)", borderColor: "var(--storefront-primary)" } : undefined}
              className={`inline-flex min-h-[36px] items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === null ? "text-white" : "border-zinc-200 bg-white text-zinc-700"
              }`}
            >
              All reviews
            </button>
            {availableFilters.map((f) => {
              const count = matches[f]?.length || 0;
              const active = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(active ? null : f)}
                  style={active ? { backgroundColor: "var(--storefront-primary)", borderColor: "var(--storefront-primary)" } : undefined}
                  className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                    active ? "text-white" : "border-zinc-200 bg-white text-zinc-700"
                  }`}
                >
                  {f}
                  <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
                    active ? "bg-white/25 text-white" : "bg-zinc-100 text-zinc-600"
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
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
                <p className="mt-2 whitespace-pre-line text-base text-zinc-800 sm:text-lg">
                  {r.body}
                </p>
              )}
            </article>
          ))}
        </div>

        {filter && pillLoading && filtered.length === 0 && (
          <p className="mt-4 text-sm text-zinc-500">Loading reviews…</p>
        )}

        {hasMore && (
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
