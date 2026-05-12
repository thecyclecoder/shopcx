/**
 * Visualize a tier's quantity by rendering the variant's transparent
 * PNG N times with overlap + a subtle tilt. One image drives all the
 * pack visuals (1-pack, 2-pack, 3-pack) without needing separate
 * stacked-render assets.
 *
 * Sizing is math-driven so the cluster always fits inside its price
 * card column at any breakpoint:
 *   - bag widths are PERCENTAGES of the container width (not fixed
 *     pixels) so a narrow mobile card scales the bags down with it.
 *   - As count goes up, each bag shrinks AND the overlap grows so
 *     the total visible width stays at most the container width.
 *   - Container is `overflow-hidden` as a safety net for the slight
 *     extra width the outer-bag tilts add.
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

  // Per-count layout (percentages of container width). Picked so the
  // total visible width — first bag plus the visible portion of each
  // subsequent bag (bagWidth - overlap) — sums to ≤ 100%.
  //   1: 60%
  //   2: 50 + (50 - 15) = 85%
  //   3: 40 + 2 × (40 - 10) = 100%
  const layouts: Record<number, { bagWidthPct: number; overlapPct: number }> = {
    1: { bagWidthPct: 60, overlapPct: 0 },
    2: { bagWidthPct: 50, overlapPct: 15 },
    3: { bagWidthPct: 40, overlapPct: 10 },
  };
  const { bagWidthPct, overlapPct } = layouts[visible];

  return (
    <div
      className={`relative mx-auto flex h-full w-full max-w-[260px] items-end justify-center overflow-hidden ${className}`}
    >
      {items.map((_, i) => {
        const offset = i - center;
        // Outer bags tilt + shrink slightly so the eye reads three
        // discrete units instead of one wide blob. Center bag stays
        // square-on with full size + the highest z-index.
        const rotate = offset === 0 ? 0 : offset * 5;
        const scale = offset === 0 ? 1 : 0.94;
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
              width: `${bagWidthPct}%`,
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
