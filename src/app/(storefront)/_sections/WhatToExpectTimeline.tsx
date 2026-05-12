import type { PageData, MediaItem } from "../_lib/page-data";
import { ShopCTA } from "../_components/ShopCTA";
import { Picture } from "../_components/PictureHero";

/**
 * "What to expect" timeline — 3-6 milestones the customer should
 * anticipate (Day 1, Week 2, Month 1, etc). Pre-sells the
 * subscription by making consistency feel like the path to results.
 *
 * Mobile: vertical timeline. Numbered bubble + connecting line on
 *         the left, label/headline/body to the right.
 * Desktop: horizontal grid with up to 5 columns. Connecting line
 *          runs across the row, bubbles centered.
 *
 * Closes with a soft CTA so the section converts on the spot for
 * the customer who's just visualized their journey.
 */
export function WhatToExpectTimeline({ data }: { data: PageData }) {
  const items = data.page_content?.expectation_timeline || [];
  if (items.length === 0) return null;

  // Per-milestone bubble images. Slot `timeline_${N+1}` for milestone
  // at index N. Falls back to a numbered bubble when no image uploaded.
  const milestoneImage = (i: number): MediaItem | null =>
    data.media_by_slot[`timeline_${i + 1}`] || null;

  const lowestPrice = data.pricing_tiers.length
    ? Math.min(...data.pricing_tiers.map((t) => t.subscribe_price_cents ?? t.price_cents))
    : null;

  return (
    <section data-section="expect" className="w-full bg-zinc-50 py-12 sm:py-16">
      <div className="mx-auto max-w-6xl px-5 md:px-8">
        <div className="mb-10 text-center md:mb-14">
          <h2 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-3xl md:text-4xl">
            What to expect
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-base text-zinc-700 sm:text-lg">
            Consistency is the key. Here&apos;s how customers typically feel as
            they stick with it.
          </p>
        </div>

        {/* Mobile: vertical timeline */}
        <ol className="relative space-y-8 md:hidden">
          {items.map((it, i) => {
            const img = milestoneImage(i);
            return (
              <li key={i} className="relative pl-20">
                {/* Connecting line — drawn behind the bubble, stops at the
                    last bubble's center. */}
                {i < items.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute left-7 top-14 h-[calc(100%+2rem)] w-px bg-zinc-300"
                  />
                )}
                <MilestoneBubble image={img} index={i} size={56} />
                <div className="text-sm font-semibold uppercase tracking-wider text-zinc-500">
                  {it.time_label}
                </div>
                <div className="mt-1 text-lg font-bold text-zinc-900">{it.headline}</div>
                <p className="mt-1 text-base leading-relaxed text-zinc-700">{it.body}</p>
              </li>
            );
          })}
        </ol>

        {/* Desktop: horizontal milestones */}
        <ol className="hidden md:grid md:grid-cols-3 md:gap-6 lg:grid-cols-5">
          {items.slice(0, 5).map((it, i, arr) => {
            const img = milestoneImage(i);
            return (
              <li key={i} className="relative flex flex-col items-center text-center">
                {/* Connecting line on the row — only between bubbles, not
                    past the first or after the last. Centered behind the
                    bubble at its vertical midpoint (32px = half of 64). */}
                {i < arr.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute left-1/2 top-8 h-px w-full bg-zinc-300"
                  />
                )}
                <div className="relative z-10">
                  <MilestoneBubble image={img} index={i} size={64} />
                </div>
                <div className="mt-4 text-sm font-semibold uppercase tracking-wider text-zinc-500">
                  {it.time_label}
                </div>
                <div className="mt-1 text-lg font-bold text-zinc-900">{it.headline}</div>
                <p className="mt-2 text-base leading-relaxed text-zinc-700">{it.body}</p>
              </li>
            );
          })}
        </ol>

        {/* (Bubble component lives below the section) */}

        {/* Soft subscription pre-sell */}
        <div className="mt-10 flex flex-col items-center gap-3 md:mt-14">
          <p className="text-center text-base font-medium text-zinc-700 sm:text-lg">
            Subscribe to lock in your routine — and save on every shipment.
          </p>
          <ShopCTA lowestPriceCents={lowestPrice} align="center" />
        </div>
      </div>
    </section>
  );
}

/**
 * Round milestone bubble. Shows the uploaded image when present
 * (timeline_1..5 slots), otherwise a numbered fallback bubble.
 * Sized via the `size` prop so the same component covers mobile
 * (56px) and desktop (64px).
 */
function MilestoneBubble({
  image,
  index,
  size,
}: {
  image: MediaItem | null;
  index: number;
  size: number;
}) {
  if (image && image.url) {
    return (
      <span
        className="absolute left-0 top-0 inline-flex items-center justify-center overflow-hidden rounded-full bg-zinc-100 ring-4 ring-white shadow-sm md:relative md:left-auto md:top-auto"
        style={{ width: size, height: size }}
      >
        <span className="block h-full w-full [&_picture]:absolute [&_picture]:inset-0 [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
          <Picture
            media={image}
            altFallback={`Milestone ${index + 1}`}
            sizes={`${size}px`}
            width={size}
            height={size}
          />
        </span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="absolute left-0 top-0 inline-flex items-center justify-center rounded-full bg-zinc-900 text-base font-bold text-white md:relative md:left-auto md:top-auto"
      style={{ width: size, height: size }}
    >
      {index + 1}
    </span>
  );
}
