/**
 * Visualize a tier's quantity by stacking the variant's transparent
 * PNG inside a cream display box.
 *
 * Two modes:
 *
 *   1. SINGLE-PRODUCT (legacy) — pass { imageUrl, count }. Renders 1-3
 *      bags of the same variant. One bag is the "prominent" hero; the
 *      rest sit behind at 0.9 opacity + 0.9 scale.
 *
 *        - 1 pack: the only bag, centered.
 *        - 2 pack: the left bag prominent, right peeks behind.
 *        - 3 pack: middle bag prominent, outer two fade behind.
 *
 *   2. MULTI-VARIANT (bundle) — pass { variants: [{ imageUrl, count }, ...] }.
 *      Renders a "1 of each variant" layer in the foreground, plus an
 *      optional faded back layer if any variant has count > 1. Used by
 *      the bundle price table where Bundle-1 = 1 coffee + 1 creamer
 *      (single front layer) and Bundle-2 = 2 coffee + 2 creamer (front
 *      pair + faded back pair).
 *
 * Sizing is HEIGHT-driven (`h-full w-auto`) so the full top + bottom
 * of the packaging is always visible — the cream box is allowed to
 * clip on the left/right edges (overflow on the horizontal axis only)
 * but never crops the bag vertically.
 *
 * Legacy mode caps visible count at 3 — beyond that the cluster looks
 * busy and the tier label already communicates the exact pack count.
 */

type Variant = { imageUrl: string | null | undefined; count: number };

export function PackageStack(props: {
  imageUrl?: string | null;
  count?: number;
  variants?: Variant[];
  className?: string;
}) {
  const { variants, className = "" } = props;

  if (variants && variants.length > 0) {
    return <BundleStack variants={variants} className={className} />;
  }

  if (!props.imageUrl || !props.count || props.count <= 0) return null;
  return <SingleStack imageUrl={props.imageUrl} count={props.count} className={className} />;
}

function SingleStack({
  imageUrl,
  count,
  className,
}: {
  imageUrl: string;
  count: number;
  className: string;
}) {
  const visible = Math.min(count, 3);
  const items = Array.from({ length: visible });
  const promIndex = visible === 3 ? 1 : 0;
  const overlapPct = visible <= 1 ? 0 : visible === 2 ? 32 : 28;

  return (
    <div
      className={`relative mx-auto flex h-full w-full items-end justify-center overflow-x-hidden rounded-lg bg-amber-50 px-2 py-2 ring-1 ring-amber-100/60 ${className}`}
    >
      {items.map((_, i) => {
        const isProm = i === promIndex;
        const offset = i - promIndex;
        const rotate = isProm ? 0 : offset * 4;
        const scale = isProm ? 1 : 0.9;
        const opacity = isProm ? 1 : 0.9;
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

/**
 * Bundle mode: variants render in two layers.
 *  - Front layer: one of each variant, full opacity, full scale.
 *  - Back layer: one of each variant behind the front pair, at 0.9
 *    opacity + 0.9 scale, slightly rotated outward, lifted up a touch.
 *
 * Only appears when at least one variant has count > 1.
 */
function BundleStack({ variants, className }: { variants: Variant[]; className: string }) {
  const usable = variants.filter(v => v.imageUrl && v.count > 0);
  if (usable.length === 0) return null;

  // 32% overlap between siblings in the same layer — matches the
  // existing 2-pack feel so the bundle reads like a tight pair.
  const overlap = 32;
  const hasBackLayer = usable.some(v => v.count > 1);

  const frontImages = usable.map(v => v.imageUrl as string);
  const backImages = hasBackLayer
    ? usable.filter(v => v.count > 1).map(v => v.imageUrl as string)
    : [];

  return (
    <div
      className={`relative mx-auto h-full w-full overflow-x-hidden rounded-lg bg-amber-50 px-2 py-2 ring-1 ring-amber-100/60 ${className}`}
    >
      {hasBackLayer && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-2 top-2 bottom-2 flex items-end justify-center"
          style={{ zIndex: 1 }}
        >
          {backImages.map((src, i) => {
            // Outer bags rotate outward a few degrees to read as "behind & peeking".
            const rotate = (i - (backImages.length - 1) / 2) * 6;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`back-${i}`}
                src={src}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="h-full w-auto max-w-none object-contain drop-shadow-md"
                style={{
                  opacity: 0.9,
                  transform: `translateY(-6%) rotate(${rotate}deg) scale(0.9)`,
                  transformOrigin: "bottom center",
                  marginLeft: i === 0 ? 0 : `-${overlap}%`,
                }}
              />
            );
          })}
        </div>
      )}

      <div className="relative flex h-full w-full items-end justify-center" style={{ zIndex: 10 }}>
        {frontImages.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`front-${i}`}
            src={src}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="h-full w-auto max-w-none object-contain drop-shadow-md"
            style={{
              transformOrigin: "bottom center",
              marginLeft: i === 0 ? 0 : `-${overlap}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
