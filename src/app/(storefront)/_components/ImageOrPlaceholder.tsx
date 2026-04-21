import Image from "next/image";

/**
 * Renders next/image when a URL is present, otherwise a solid gray
 * placeholder block with the requested aspect ratio. Never renders a
 * broken <img>.
 */
export function ImageOrPlaceholder({
  src,
  alt,
  width,
  height,
  aspect,
  sizes,
  priority = false,
  fetchPriority,
  fill = false,
  className = "",
}: {
  src: string | null | undefined;
  alt: string;
  width?: number;
  height?: number;
  aspect?: string; // e.g. "4/3" — used for placeholder sizing
  sizes?: string;
  priority?: boolean;
  fetchPriority?: "high" | "low" | "auto";
  fill?: boolean;
  className?: string;
}) {
  if (!src) {
    const style = aspect
      ? { aspectRatio: aspect.replace("/", " / ") }
      : width && height
        ? { aspectRatio: `${width} / ${height}` }
        : undefined;
    return (
      <div
        aria-hidden="true"
        className={`w-full bg-zinc-100 ${className}`}
        style={style}
      />
    );
  }

  // next/image's `priority` sets loading=eager but does NOT set
  // fetchpriority=high on the rendered <img>. Pass it explicitly so
  // hero images get the browser-level priority hint Chrome uses for
  // LCP scheduling.
  const resolvedFetchPriority =
    fetchPriority || (priority ? "high" : undefined);

  if (fill) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        fetchPriority={resolvedFetchPriority}
        loading={priority ? undefined : "lazy"}
        className={className || "object-cover"}
      />
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={width || 1200}
      height={height || 900}
      sizes={sizes}
      priority={priority}
      fetchPriority={resolvedFetchPriority}
      loading={priority ? undefined : "lazy"}
      className={className}
    />
  );
}
