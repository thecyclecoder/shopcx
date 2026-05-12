/**
 * Visualize a tier's quantity by stacking the variant's transparent
 * PNG. Bag size stays constant across 1/2/3-pack — only the overlap
 * changes. The cream-tinted box clips any spillover so the cluster
 * reads as a curated "display" rather than a row of perfectly framed
 * thumbnails. One image drives all the pack visuals; no separate
 * stacked-render assets needed.
 *
 * Math:
 *   - bag width is a fixed 65% of the container at every count, so a
 *     2-bag pack and a 3-bag pack both feature life-size bags.
 *   - overlap percentage grows with count so the cluster compresses
 *     into the box; for the 3-pack, outer bags crop ~10% on each
 *     side — intentional, communicates "fully stocked" rather than
 *     "this is too small to fit".
 *
 *  1: 65% centered, no overlap.
 *  2: 65% + 65% with 20% overlap = 110% (mild bleed, ~5% per side).
 *  3: 65% + 65% + 65% with 30% overlap = 135% (clear bleed, ~17% per
 *     side — bags peek off the edges like product on a shelf).
 *
 * Caps the visible count at 3 — beyond that the cluster looks busy
 * and the tier label already communicates the exact pack count.
 */
export function PackageStack({
  imageUrl,
  count,
  className = "",
}: {
  imageUrl: string | null | undefined;
  count: number;
  className?: string;
}) {
  if (!imageUrl || count <= 0) return null;

  const visible = Math.min(count, 3);
  const items = Array.from({ length: visible });
  const center = Math.floor((visible - 1) / 2);

  // Fixed bag size across counts; only overlap changes.
  const BAG_WIDTH_PCT = 65;
  const overlapPct = visible <= 1 ? 0 : visible === 2 ? 20 : 30;

  return (
    <div
      className={`relative mx-auto flex h-full w-full items-end justify-center overflow-hidden rounded-xl bg-amber-50 ring-1 ring-amber-100/60 ${className}`}
    >
      {items.map((_, i) => {
        const offset = i - center;
        // Outer bags tilt slightly so the eye reads multiple discrete
        // units instead of one wide blob. No size variance between
        // them — every bag is the same scale.
        const rotate = offset === 0 ? 0 : offset * 5;
        const translateY = offset === 0 ? 0 : 6;
        const z = visible - Math.abs(offset);

        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={imageUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="h-auto object-contain drop-shadow-md"
            style={{
              width: `${BAG_WIDTH_PCT}%`,
              transform: `translateY(${translateY}px) rotate(${rotate}deg)`,
              transformOrigin: "bottom center",
              marginLeft: i === 0 ? 0 : `-${overlapPct}%`,
              zIndex: z,
            }}
          />
        );
      })}
    </div>
  );
}
