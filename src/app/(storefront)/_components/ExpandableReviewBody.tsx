"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Renders a review body line-clamped to 5 lines. After hydration we
 * measure the rendered paragraph: if it actually overflows the clamp,
 * a "See full review" toggle appears. Clicking expands in place.
 *
 * Measurement-based (not char-count heuristic) so the toggle only
 * appears when text is genuinely truncated — short reviews in a wide
 * card don't get a useless button, and long reviews in a narrow card
 * always do.
 */
export function ExpandableReviewBody({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const check = () => {
      const el = ref.current;
      if (!el) return;
      // scrollHeight > clientHeight means the clamp is hiding content.
      // +1 absorbs sub-pixel rounding on Retina displays.
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [text]);

  return (
    <div className="mt-2">
      <p
        ref={ref}
        className={`text-sm leading-relaxed text-zinc-700 ${expanded ? "" : "line-clamp-5"}`}
      >
        {text}
      </p>
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ color: "var(--storefront-primary)" }}
          className="mt-2 inline-flex items-center text-sm font-semibold hover:underline"
        >
          {expanded ? "Show less" : "See full review →"}
        </button>
      )}
    </div>
  );
}
