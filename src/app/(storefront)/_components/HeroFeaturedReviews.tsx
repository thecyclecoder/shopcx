"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { Review } from "../_lib/page-data";
import { fetchReviewsBootstrap } from "../_lib/reviews-bootstrap-cache";

/**
 * Hero featured reviews — random rotation over the truly-featured pool.
 *
 * SSG payload provides the initial set so first paint has content
 * (good for SEO + LCP). On mount, /reviews-bootstrap returns the
 * latest featured pool and we shuffle for display order, so multiple
 * visits surface different stories. Featured-only filter: Klaviyo's
 * smart_featured (status="featured" / featured=true).
 */

const ROTATE_MS = 15000;
const TRUNCATE = 260;

function truncate(str: string, max: number) {
  if (!str || str.length <= max) return { text: str || "", cut: false };
  let cut = str.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return { text: cut.replace(/\s+$/, "") + "…", cut: true };
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function HeroFeaturedReviews({
  reviews,
  workspaceSlug,
  slug,
}: {
  reviews: Review[];
  workspaceSlug?: string;
  slug?: string;
}) {
  const initialFeatured = useMemo(
    () =>
      reviews.filter(
        (r) =>
          (r.featured === true || r.status === "featured") &&
          (r.body || r.title || r.smart_quote),
      ),
    [reviews],
  );
  const [pool, setPool] = useState<Review[]>(initialFeatured);

  // Refresh featured pool on mount so new featured reviews appear
  // without ISR. Falls back to SSG initial state on any failure.
  useEffect(() => {
    if (!workspaceSlug || !slug) return;
    let abort = false;
    fetchReviewsBootstrap(workspaceSlug, slug)
      .then((body) => {
        if (abort) return;
        if (body.featured?.length) {
          const filtered = body.featured.filter(
            (r) => r.body || r.title || r.smart_quote,
          );
          if (filtered.length) setPool(filtered);
        }
      })
      .catch(() => {
        /* keep initial */
      });
    return () => {
      abort = true;
    };
  }, [workspaceSlug, slug]);

  // Stable shuffle for this mount — order doesn't jump as the user
  // expands/collapses. Re-randomizes on every new pool (i.e. every
  // page visit since the component remounts).
  const usable = useMemo(() => shuffle(pool), [pool]);
  const [idx, setIdx] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const advance = useCallback((dir: "prev" | "next") => {
    if (!usable.length) return;
    setFadeOut(true);
    setTimeout(() => {
      setIdx(prev => {
        const next = dir === "prev"
          ? (prev - 1 + usable.length) % usable.length
          : (prev + 1) % usable.length;
        return next;
      });
      setExpanded(false);
      setFadeOut(false);
    }, 180);
  }, [usable.length]);

  useEffect(() => {
    if (usable.length <= 1) return;
    timerRef.current = setInterval(() => advance("next"), ROTATE_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [usable.length, advance]);

  function resetTimer() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (usable.length > 1) {
      timerRef.current = setInterval(() => advance("next"), ROTATE_MS);
    }
  }

  if (!usable.length) return null;

  const r = usable[idx % usable.length];
  const headline = r.smart_quote || r.title || (r.body ? r.body.split(/[.!?]/)[0] + "." : "Loved it");
  const bodyRaw = r.body || "";
  const showBody = bodyRaw && bodyRaw !== headline;
  const { text: bodyText, cut } = showBody
    ? (expanded ? { text: bodyRaw, cut: false } : truncate(bodyRaw, TRUNCATE))
    : { text: "", cut: false };
  const author = r.reviewer_name || "Verified Customer";

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
      <div
        className={`transition-opacity duration-200 ${fadeOut ? "opacity-0" : "opacity-100"}`}
      >
        <div className="mb-2 flex items-center gap-0.5 text-amber-500" aria-label="5 out of 5 stars">
          {"★★★★★"}
        </div>
        <p className="text-lg font-semibold leading-snug text-zinc-900 sm:text-xl">
          <span aria-hidden="true" className="mr-1 text-zinc-400">{"“"}</span>
          {headline}
        </p>
        {showBody && bodyText && (
          <p className="mt-2 text-base leading-relaxed text-zinc-700">
            {"“"}{bodyText}{"”"}
          </p>
        )}
        {cut && !expanded && (
          <button
            type="button"
            onClick={() => { setExpanded(true); resetTimer(); }}
            style={{ color: "var(--storefront-primary)" }}
            className="mt-1 text-sm font-medium hover:underline"
          >
            Read full review
          </button>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-zinc-900">{author}</span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white"
              >
                ✓
              </span>
              Verified
            </span>
          </div>
          {usable.length > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous review"
                onClick={() => { advance("prev"); resetTimer(); }}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg leading-none text-zinc-700 hover:border-zinc-400"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next review"
                onClick={() => { advance("next"); resetTimer(); }}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg leading-none text-zinc-700 hover:border-zinc-400"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
