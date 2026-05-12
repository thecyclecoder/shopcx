/**
 * Visualize a tier's quantity by stacking the variant's transparent
 * PNG inside a cream display box. One bag is the "prominent" hero;
 * the rest sit behind at 0.9 opacity + 0.9 scale so the cluster
 * reads as one product with supporting copies, not a flat lineup of
 * equally-weighted bags.
 *
 * Sizing is HEIGHT-driven (`h-full w-auto`) instead of width-driven
 * so the full top + bottom of the packaging is always visible — the
 * cream box is allowed to clip on the left/right edges (overflow on
 * the horizontal axis only) but never crops the bag vertically.
 *
 * Prominent bag:
 *   - 1 pack: the only bag, centered.
 *   - 2 pack: the left bag (right one peeks behind).
 *   - 3 pack: the middle bag (outer two fade behind on each side).
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
  // Which index is the prominent / hero bag:
  //   1 visible → index 0
  //   2 visible → index 0 (left prominent, right peeks behind)
  //   3 visible → index 1 (middle prominent, outer two behind)
  const promIndex = visible === 3 ? 1 : 0;

  // Overlap is a percentage of the CONTAINER width (not the bag
  // width) so the layout stays predictable even though each bag's
  // width is auto-derived from the container height + aspect ratio.
  const overlapPct = visible <= 1 ? 0 : visible === 2 ? 32 : 28;

  return (
    <div
      className={`relative mx-auto flex h-full w-full items-end justify-center overflow-x-hidden rounded-xl bg-amber-50 px-2 py-2 ring-1 ring-amber-100/60 ${className}`}
    >
      {items.map((_, i) => {
        const isProm = i === promIndex;
        const offset = i - promIndex;
        const rotate = isProm ? 0 : offset * 4;
        const scale = isProm ? 1 : 0.9;
        const opacity = isProm ? 1 : 0.9;
        // Binary z-index — depth comes from scale + opacity, but the
        // prominent bag must always paint on top of its neighbors
        // regardless of DOM order.
        const z = isProm ? 10 : 1;

        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={imageUrl}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="h-full w-auto max-w-none object-contain drop-shadow-md"
            style={{
              opacity,
              transform: `rotate(${rotate}deg) scale(${scale})`,
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
