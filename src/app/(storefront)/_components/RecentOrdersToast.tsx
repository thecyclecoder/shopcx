"use client";

import { useEffect, useState } from "react";
import type { RecentOrderForProof } from "../_lib/page-data";

/**
 * Social-proof toast that slides up from the bottom-left, holds for 5s,
 * slides out, waits a randomized gap, then shows the next order.
 *
 * Replaces the old "Order now" sticky CTA. The product CTA is already
 * featured in the hero / why-this-works / final CTA sections; this
 * little proof element reinforces "real people are buying this right now"
 * without adding another button.
 *
 * Performance:
 *   - All data comes pre-baked in PageData (SSG). No client fetch.
 *   - CSS transform-based slide. No layout thrash.
 *   - Single React state per cycle. No global listeners.
 *   - If `orders.length === 0` we render nothing.
 *
 * Timing:
 *   - First toast appears ~3s after mount (lets the page settle).
 *   - Each toast shows for 5s, then slides out.
 *   - Gap between toasts randomized in [7s, 18s] so it doesn't feel
 *     metronomic.
 *   - Loops the list (newest first) so the page always feels "alive".
 */
export function RecentOrdersToast({ orders }: { orders: RecentOrderForProof[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!orders.length) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const showAt = (i: number) => {
      if (cancelled) return;
      setActiveIndex(i);
      // Next frame: slide in
      timers.push(setTimeout(() => { if (!cancelled) setVisible(true); }, 50));
      // Hold for 5s, then slide out
      timers.push(setTimeout(() => { if (!cancelled) setVisible(false); }, 5000));
      // After slide-out animation (~400ms), wait a random gap, then show next
      const gapMs = 7000 + Math.floor(Math.random() * 11000); // 7s–18s
      timers.push(setTimeout(() => {
        if (cancelled) return;
        const next = (i + 1) % orders.length;
        showAt(next);
      }, 5000 + 400 + gapMs));
    };

    // Initial delay so the toast doesn't appear during page paint.
    timers.push(setTimeout(() => showAt(0), 3000));

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
  }, [orders.length]);

  if (!orders.length || activeIndex == null) return null;
  const order = orders[activeIndex];

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className={`pointer-events-none fixed bottom-4 left-3 right-3 z-40 transition-all duration-300 ease-out sm:right-auto sm:left-4 sm:max-w-sm ${
        visible ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0"
      }`}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 pr-4 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.18)]">
        {order.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={order.image_url}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            className="h-12 w-12 flex-shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="h-12 w-12 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div className="min-w-0 flex-1 text-sm leading-snug text-zinc-900">
          <div className="font-medium">
            {order.first_name}
            {order.last_initial ? ` ${order.last_initial}.` : ""}
            {order.state ? ` in ${order.state}` : ""}
          </div>
          <div className="text-zinc-500">
            just bought {order.product_title}
          </div>
        </div>
      </div>
    </div>
  );
}
