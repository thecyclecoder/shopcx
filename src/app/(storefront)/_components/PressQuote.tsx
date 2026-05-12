"use client";

import { useEffect, useState } from "react";

/**
 * Inline press-quote pull. Direct-response staple: a single line of
 * borrowed authority right next to the buying decision. Parses the
 * admin's "Award" entries which can come in two forms:
 *
 *   1. "Best Tasting Superfood Coffee — Gourmet Magazine"
 *   2. Just the source: "Featured in Forbes" — no quote piece.
 *
 * The em-dash (— or --) splits quote/source; falls back to rendering
 * the whole string when there's no separator. Rotates through every
 * 6s when more than one is provided so visitors who linger see them
 * all without us building a full carousel.
 */
export function PressQuote({
  items,
  variant = "dark",
  className = "",
}: {
  items: string[] | null | undefined;
  variant?: "light" | "dark";
  className?: string;
}) {
  const list = (items || []).filter((s) => s && s.trim());
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (list.length <= 1) return;
    const t = setInterval(() => {
      setIdx((p) => (p + 1) % list.length);
    }, 6000);
    return () => clearInterval(t);
  }, [list.length]);

  if (list.length === 0) return null;

  const item = list[idx % list.length] || "";
  const split = item.split(/\s+[—–-]{1,2}\s+/);
  const hasSource = split.length >= 2;
  const quote = hasSource ? split.slice(0, -1).join(" — ") : item;
  const source = hasSource ? split[split.length - 1] : null;

  const textColor = variant === "dark" ? "text-zinc-100" : "text-zinc-900";
  const sourceColor = variant === "dark" ? "text-amber-300" : "text-zinc-500";

  return (
    <div
      aria-live="polite"
      className={`inline-flex max-w-full items-baseline gap-2 ${textColor} ${className}`}
    >
      <span className="text-amber-400" aria-hidden="true">
        ★
      </span>
      <span className="text-base font-medium leading-snug sm:text-lg">
        <span className="italic">&ldquo;{quote}&rdquo;</span>
        {source && (
          <span className={`ml-2 text-sm font-semibold uppercase tracking-wide sm:text-base ${sourceColor}`}>
            — {source}
          </span>
        )}
      </span>
    </div>
  );
}
