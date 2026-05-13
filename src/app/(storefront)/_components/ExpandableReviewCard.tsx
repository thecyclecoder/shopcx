"use client";

/**
 * Pull-quote review card with truncation + expand toggle.
 * Used in the UpsellChapter (and reusable for any place that shows a
 * curated review in a small card without a full review feed).
 *
 * Behavior:
 *   - Short reviews (under TRUNCATE_AT chars) render in full, no toggle.
 *   - Longer reviews show the first TRUNCATE_AT chars + "Read full
 *     review" link. Clicking expands to show the whole body in place
 *     and swaps the link to "Show less."
 */

import { useState } from "react";

const TRUNCATE_AT = 260;

interface Props {
  id: string;
  body: string;
  reviewerName: string;
  rating: number;
  // Color tokens passed in so the card stays neutral about the
  // section's background (dark partner-bg vs light fallback).
  fgText: string;
  fgMuted: string;
  cardBg: string;
  borderColor: string;
  linkColor: string;
}

/**
 * Truncate body text on the nearest sentence boundary within the
 * char window. Falls back to last word boundary if no sentence break
 * lands in a sensible spot (must be at least halfway through the
 * window so the teaser still has substance).
 *
 * We use this — not the AI smart_quote — because smart_quote tends to
 * be the OPENING line of the review (context/setup), while the punch
 * usually lands a sentence or two later. Pulling the first ~260 chars
 * of the actual body gives the reader the context AND the start of
 * the payoff, making "Read full review" feel earned.
 */
function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (lastEnd > maxChars * 0.5) {
    return text.slice(0, lastEnd + 1);
  }
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd() + "…";
}

export function ExpandableReviewCard({
  body,
  reviewerName,
  rating,
  fgText,
  fgMuted,
  cardBg,
  borderColor,
  linkColor,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  const fullBody = (body || "").trim();
  if (!fullBody) return null;

  const collapsedDisplay = smartTruncate(fullBody, TRUNCATE_AT);
  const hasMore = collapsedDisplay.length < fullBody.length;

  return (
    <figure
      className="rounded-2xl border p-5"
      style={{ backgroundColor: cardBg, borderColor }}
    >
      <Stars rating={rating} />
      <blockquote
        className="mt-3 text-[16px] leading-relaxed"
        style={{ color: fgText }}
      >
        &ldquo;{expanded ? fullBody : collapsedDisplay}&rdquo;
      </blockquote>
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs font-semibold uppercase tracking-wider underline-offset-2 hover:underline"
          style={{ color: linkColor }}
        >
          {expanded ? "Show less" : "Read full review"}
        </button>
      )}
      <figcaption
        className="mt-3 text-xs font-semibold uppercase tracking-wider"
        style={{ color: fgMuted }}
      >
        — {reviewerName}
      </figcaption>
    </figure>
  );
}

function Stars({ rating }: { rating: number }) {
  const filled = Math.round(rating);
  return (
    <div className="flex items-center gap-0.5 text-amber-400">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill={i < filled ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      ))}
    </div>
  );
}
