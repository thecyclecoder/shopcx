"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { Review } from "../_lib/page-data";

/**
 * Hero featured reviews — ported from the customer portal's ReviewsCard.
 * Round-robin across linked products is handled upstream (page-data
 * already pools + sorts featured > rating > recency). This component
 * just rotates through the pre-sorted list every 15s with a fade.
 *
 * Performance: this component is rendered inside HeroSection, which is
 * already a client component. The first review is part of initial state
 * so it's serialized into the SSR HTML — no JS needed for first paint.
 * The 15s rotation timer kicks in only after hydration. No extra fetch:
 * reviews come in on the page-data payload that the page already loads.
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

export function HeroFeaturedReviews({ reviews }: { reviews: Review[] }) {
  // Drop reviews with no usable text — keeps the carousel from showing
  // blank cards when a review row has only a rating number.
  const usable = reviews.filter(r => r.body || r.title || r.smart_quote);
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
