/**
 * Visualize a tier's quantity by stacking the variant's transparent
 * PNG inside a cream display box.
 *
 * Two modes:
 *
 *   1. SINGLE-PRODUCT (legacy) — pass { imageUrl, count }. Renders 1-3
 *      bags of the same variant inside one cream box. One bag is the
 *      "prominent" hero; the rest sit behind at 0.9 opacity + 0.9
 *      scale.
 *
 *        - 1 pack: the only bag, centered.
 *        - 2 pack: the left bag prominent, right peeks behind.
 *        - 3 pack: middle bag prominent, outer two fade behind.
 *
 *   2. MULTI-VARIANT (bundle) — pass { variants: [{ imageUrl, count }, ...] }.
 *      Splits the cream box into N equal-width columns (one per
 *      variant) and renders each variant as its own single-product
 *      stack inside its column. So Bundle-1 = a coffee bag on the
 *      left, a creamer bag on the right; Bundle-2 = a 2-pack stack
 *      of coffee on the left, a 2-pack stack of creamer on the right.
 *      The two halves don't overlap each other — only the bags within
 *      a single half overlap (the existing 2-pack treatment).
 *
 * Sizing is HEIGHT-driven (`h-full w-auto`) so the full top + bottom
 * of the packaging is always visible — the cream box is allowed to
 * clip on the left/right edges but never crops the bag vertically.
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
  return (
    <CreamBox className={className}>
      <StackInner imageUrl={props.imageUrl} count={props.count} />
    </CreamBox>
  );
}

/**
 * Shared cream-box wrapper used by both single and bundle modes.
 * Overflow is horizontal-only so vertical bag clipping never happens.
 */
function CreamBox({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <div
      className={`relative mx-auto h-full w-full overflow-x-hidden rounded-lg bg-amber-50 px-2 py-2 ring-1 ring-amber-100/60 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Single-product stack inner — bags only, no cream box wrapper.
 * Used by both the single-product PackageStack call and by each
 * column of a BundleStack.
 */
function StackInner({
  imageUrl,
  count,
}: {
  imageUrl: string;
  count: number;
}) {
  const visible = Math.min(count, 3);
  const items = Array.from({ length: visible });
  // Prominent bag index:
  //   1 visible → 0 (centered solo)
  //   2 visible → 0 (left prominent, right peeks behind)
  //   3 visible → 1 (middle prominent, outer two behind)
  const promIndex = visible === 3 ? 1 : 0;

  // Overlap relative to the CONTAINER width — predictable across
  // variable bag widths.
  const overlapPct = visible <= 1 ? 0 : visible === 2 ? 32 : 28;

  return (
    <div className="flex h-full w-full items-end justify-center">
      {items.map((_, i) => {
        const isProm = i === promIndex;
        const offset = i - promIndex;
        const rotate = isProm ? 0 : offset * 4;
        const scale = isProm ? 1 : 0.9;
        const opacity = isProm ? 1 : 0.9;
        // Binary z-index — the prominent bag must paint on top of its
        // neighbors regardless of DOM order.
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
 * Bundle mode: split the cream box into equal-width columns, one per
 * variant. Each column shows ONE bag image (regardless of count) so
 * the bundle reads as "primary + upsell" at a glance — never a
 * stacked tower. When the per-variant count is greater than one, an
 * "N-Pack" pill overlays the bag in that column so quantity stays
 * legible without the visual clutter of overlapping packaging.
 *
 * Sizing is constrained on BOTH axes here (max-h + max-w) instead of
 * single-product mode's height-driven approach — the column is only
 * half the container width and the bag images often include lifestyle
 * setups (cup, ingredients) that are wider than tall, so a pure
 * height fit would overflow the column on mobile and clip into the
 * neighboring bag.
 */
function BundleStack({ variants, className }: { variants: Variant[]; className: string }) {
  const usable = variants.filter((v) => v.imageUrl && v.count > 0);
  if (usable.length === 0) return null;

  return (
    <CreamBox className={className}>
      <div className="flex h-full w-full items-end gap-1">
        {usable.map((v, i) => (
          <div
            key={i}
            className="relative flex h-full min-w-0 flex-1 items-end justify-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={v.imageUrl as string}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              className="max-h-full max-w-full object-contain drop-shadow-md"
            />
            {v.count > 1 && (
              <span
                className="absolute left-1/2 top-1 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-orange-500 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-wider text-white shadow-md sm:text-xs"
              >
                {v.count}-Pack
              </span>
            )}
          </div>
        ))}
      </div>
    </CreamBox>
  );
}
