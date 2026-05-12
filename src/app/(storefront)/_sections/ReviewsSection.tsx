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

  // For each benefit, build a keyword set from customer_phrases on the
  // benefit selection PLUS the AI-extracted top_benefits whose name
  // overlaps. Substring match against the benefit_name alone almost
  // never hits review bodies (admin labels like "Cardiovascular Health"
  // don't appear verbatim in real reviews), so without this the pills
  // showed empty results and damaged trust. Pills with zero matches
  // in the loaded set are hidden — guarantees every visible pill works.
  const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "with",
    "support", "supports", "health", "amp", "system",
  ]);
  const meaningfulTokens = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const benefitMatches = useMemo(() => {
    const map: Record<string, string[]> = {};
    const topBenefits = data.review_analysis?.top_benefits || [];

    for (const b of data.benefit_selections) {
      if (b.role !== "lead" && b.role !== "supporting") continue;

      const phrases = new Set<string>();
      for (const p of b.customer_phrases || []) {
        if (p && p.trim()) phrases.add(p.trim().toLowerCase());
      }

      // Fuzzy-match top_benefits by name token overlap so admin's
      // "Energy & Performance" picks up AI's "Energy boost without jitters"
      // and all the customer phrases that came with it.
      const benefitTokens = new Set(meaningfulTokens(b.benefit_name));
      for (const tb of topBenefits) {
        const tbTokens = meaningfulTokens(tb.benefit || "");
        const overlap = tbTokens.some((t) => benefitTokens.has(t));
        if (overlap) {
          for (const p of tb.customer_phrases || []) {
            if (p && p.trim()) phrases.add(p.trim().toLowerCase());
          }
        }
      }

      if (phrases.size === 0) continue;

      const matched: string[] = [];
      const phraseList = Array.from(phrases);
      for (const r of reviews) {
        const body = (r.body || "").toLowerCase();
        if (phraseList.some((p) => body.includes(p))) matched.push(r.id);
      }
      if (matched.length > 0) map[b.benefit_name] = matched;
    }
    return map;
  }, [reviews, data.benefit_selections, data.review_analysis]);

  const availableFilters = useMemo(() => {
    return data.benefit_selections
      .filter(
        (b) =>
          (b.role === "lead" || b.role === "supporting") &&
          (benefitMatches[b.benefit_name]?.length || 0) > 0,
      )
      .map((b) => b.benefit_name)
      .slice(0, 6);
  }, [data.benefit_selections, benefitMatches]);

  const filtered = useMemo(() => {
    if (!filter) return reviews;
    const ids = new Set(benefitMatches[filter] || []);
    return reviews.filter((r) => ids.has(r.id));
  }, [reviews, filter, benefitMatches]);

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
        <h2 className="mb-4 text-center text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-left md:text-4xl">
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
              style={filter === null ? { backgroundColor: "var(--storefront-primary)", borderColor: "var(--storefront-primary)" } : undefined}
              className={`inline-flex min-h-[36px] items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === null ? "text-white" : "border-zinc-200 bg-white text-zinc-700"
              }`}
            >
              All reviews
            </button>
            {availableFilters.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(filter === f ? null : f)}
                style={filter === f ? { backgroundColor: "var(--storefront-primary)", borderColor: "var(--storefront-primary)" } : undefined}
                className={`inline-flex min-h-[36px] items-center rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f ? "text-white" : "border-zinc-200 bg-white text-zinc-700"
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
