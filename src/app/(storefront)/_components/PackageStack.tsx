/**
 * Visualize a tier's quantity by stacking the variant's transparent
 * PNG inside a cream display box. One bag is the "prominent" hero;
 * the rest sit behind at reduced opacity + 10% smaller scale so the
 * cluster reads as one product with supporting copies, not a flat
 * lineup of equally-weighted bags.
 *
 * Prominent bag:
 *   - 1 pack: the only bag, dead-center.
 *   - 2 pack: the first/left bag (overlap shows the second peeking
 *     behind it on the right).
 *   - 3 pack: the middle bag (others fade behind on each side).
 *
 * Non-prominent bags get opacity 0.75 + scale 0.9; prominent bag is
 * full opacity + full size with the highest z-index so it always
 * sits on top regardless of DOM order.
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
  //   2 visible → index 0 (left bag prominent, right peeks behind)
  //   3 visible → index 1 (middle prominent, outer two fade behind)
  const promIndex = visible === 3 ? 1 : 0;

  // Fixed hero bag size; non-prominent shrink 10%. Overlap grows
  // with count so the cluster tightens — 2-pack pulls the second bag
  // partly behind the first, 3-pack tucks both outer bags behind the
  // middle.
  const BAG_WIDTH_PCT = 65;
  const overlapPct = visible <= 1 ? 0 : visible === 2 ? 35 : 30;

  return (
    <div
      className={`relative mx-auto flex h-full w-full items-end justify-center overflow-hidden rounded-xl bg-amber-50 ring-1 ring-amber-100/60 ${className}`}
    >
      {items.map((_, i) => {
        const isProm = i === promIndex;
        const offset = i - promIndex;
        const rotate = isProm ? 0 : offset * 5;
        const scale = isProm ? 1 : 0.9;
        const opacity = isProm ? 1 : 0.75;
        const translateY = isProm ? 0 : 8;
        // Binary z-index — depth comes from scale + opacity, but the
        // prominent bag must always paint on top of its neighbors.
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
            className="h-auto object-contain drop-shadow-md"
            style={{
              width: `${BAG_WIDTH_PCT}%`,
              opacity,
              transform: `translateY(${translateY}px) rotate(${rotate}deg) scale(${scale})`,
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
