/**
 * Visualize a tier's quantity by rendering the product variant's
 * isolated packaging PNG N times with a slight overlap + subtle tilt.
 * Avoids the need to upload a separate 1-pack / 2-pack / 3-pack
 * rendered image — one transparent PNG per variant drives all of
 * them. Uses the variant image (not a workspace-level "packaging"
 * slot) so future flavor selection cleanly swaps the artwork.
 *
 * Caps visual count at 3: beyond that the lineup looks busy and the
 * tier label (e.g. "6-pack") already communicates the exact count.
 * Outer bags are slightly smaller and tilted away from center so the
 * cluster reads as multiple discrete units, not a stretched single
 * bag.
 *
 * Renders nothing when no image is provided.
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
  const src = imageUrl;

  const visible = Math.min(count, 3);
  const items = Array.from({ length: visible });
  const center = Math.floor((visible - 1) / 2);

  return (
    <div
      className={`relative flex items-end justify-center ${className}`}
      style={{ minHeight: 0 }}
    >
      {items.map((_, i) => {
        const offset = i - center;
        // Outer bags tilt + shrink slightly so the eye reads three
        // discrete units instead of one wide blob. Center bag stays
        // square-on with full size + the highest z-index.
        const rotate = offset === 0 ? 0 : offset * 6;
        const scale = offset === 0 ? 1 : 0.92;
        const translateY = offset === 0 ? 0 : 6;
        const z = visible - Math.abs(offset);

        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={src}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="h-full max-h-40 w-auto object-contain drop-shadow-md"
            style={{
              transform: `translateY(${translateY}px) rotate(${rotate}deg) scale(${scale})`,
              transformOrigin: "bottom center",
              marginLeft: i === 0 ? 0 : "-1.75rem",
              zIndex: z,
            }}
          />
        );
      })}
    </div>
  );
}
