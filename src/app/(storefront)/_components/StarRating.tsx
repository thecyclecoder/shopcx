/**
 * Inline SVG star rating. Server component — zero JS.
 * `rating` is 0-5 (supports halves via fractional values).
 */
export function StarRating({
  rating,
  size = 16,
  className = "",
}: {
  rating: number;
  size?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(5, rating));
  const full = Math.floor(clamped);
  const half = clamped - full >= 0.5;

  return (
    <span
      className={`inline-flex items-center gap-0.5 text-amber-500 ${className}`}
      aria-label={`${clamped.toFixed(1)} out of 5 stars`}
    >
      {Array.from({ length: 5 }).map((_, i) => {
        if (i < full) return <FilledStar key={i} size={size} />;
        if (i === full && half) return <HalfStar key={i} size={size} />;
        return <EmptyStar key={i} size={size} />;
      })}
    </span>
  );
}

function FilledStar({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 1.5l2.7 5.5 6 .9-4.4 4.3 1 6L10 15.3l-5.4 2.9 1-6-4.3-4.3 6-.9L10 1.5z" />
    </svg>
  );
}

function EmptyStar({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M10 1.5l2.7 5.5 6 .9-4.4 4.3 1 6L10 15.3l-5.4 2.9 1-6-4.3-4.3 6-.9L10 1.5z" />
    </svg>
  );
}

function HalfStar({ size }: { size: number }) {
  const id = `half-${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="1">
          <stop offset="50%" stopColor="currentColor" />
          <stop offset="50%" stopColor="transparent" />
        </linearGradient>
      </defs>
      <path
        d="M10 1.5l2.7 5.5 6 .9-4.4 4.3 1 6L10 15.3l-5.4 2.9 1-6-4.3-4.3 6-.9L10 1.5z"
        fill={`url(#${id})`}
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}
