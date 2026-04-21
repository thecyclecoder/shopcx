import type { MediaItem } from "../_lib/page-data";
import { pictureSources } from "../_lib/image-urls";

/**
 * Native <picture> element that uses our pre-transcoded AVIF/WebP
 * variants, served through the /storefront-img edge proxy for
 * cold-cache-proof delivery. Never goes through /_next/image, so
 * there's no serverless optimizer function in the critical path.
 *
 * `role="hero"` flips on fetchpriority=high + eager loading for the
 * LCP image. Everything else lazy-loads like a normal web image.
 *
 * Renders a gray aspect-ratio placeholder when no media is present —
 * never a broken <img>.
 */
export function Picture({
  media,
  altFallback,
  sizes,
  width,
  height,
  role = "content",
  className = "",
}: {
  media: MediaItem | null | undefined;
  altFallback: string;
  sizes: string;
  width: number;
  height: number;
  role?: "hero" | "content";
  className?: string;
}) {
  const sources = pictureSources(media, altFallback, sizes);

  if (!sources) {
    return (
      <div
        aria-hidden="true"
        className={`w-full bg-zinc-100 ${className}`}
        style={{ aspectRatio: `${width} / ${height}` }}
      />
    );
  }

  const isHero = role === "hero";

  return (
    <picture>
      {sources.avifSrcSet && (
        <source type="image/avif" srcSet={sources.avifSrcSet} sizes={sizes} />
      )}
      {sources.webpSrcSet && (
        <source type="image/webp" srcSet={sources.webpSrcSet} sizes={sizes} />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={sources.fallbackSrc}
        alt={sources.alt}
        width={width}
        height={height}
        fetchPriority={isHero ? "high" : "auto"}
        loading={isHero ? "eager" : "lazy"}
        decoding="async"
        className={className}
      />
    </picture>
  );
}

/** Back-compat alias — `PictureHero` keeps working for older call sites. */
export function PictureHero(
  props: Omit<Parameters<typeof Picture>[0], "role">,
) {
  return <Picture {...props} role="hero" />;
}
