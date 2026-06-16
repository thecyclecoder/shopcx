/**
 * 30-Day Money-Back Guarantee seal — a circular "stamp" trust badge.
 *
 * Pure SVG, no JS — safe to render server-side and reuse anywhere
 * (guarantee modal, BrandTrustSection, FinalCTA, etc.). Inherits the
 * storefront's primary brand color via `color` so it matches each
 * workspace's theme; pass `color` to override.
 */
export function GuaranteeSeal({
  size = 160,
  color,
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={className}
      role="img"
      aria-label="30-day money-back guarantee"
      style={{ color: color || "var(--storefront-primary, #1f5e3a)" }}
    >
      <defs>
        {/* upper arc (text reads upright, left→right over the top) */}
        <path id="gs-top" d="M34,100 a66,66 0 0,1 132,0" fill="none" />
        {/* lower arc (text reads upright, left→right along the bottom) */}
        <path id="gs-bot" d="M34,100 a66,66 0 0,0 132,0" fill="none" />
      </defs>

      {/* seal disc + stamped rim */}
      <circle cx="100" cy="100" r="96" fill="currentColor" />
      <circle cx="100" cy="100" r="88" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="5" strokeDasharray="1.5 7" />
      <circle cx="100" cy="100" r="80" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="1.5" />

      {/* curved labels */}
      <text fill="#ffffff" fontSize="14.5" fontWeight="700" letterSpacing="1.4">
        <textPath href="#gs-top" startOffset="50%" textAnchor="middle">MONEY-BACK GUARANTEE</textPath>
      </text>
      <text fill="#ffffff" fillOpacity="0.9" fontSize="10.5" fontWeight="600" letterSpacing="2.2">
        <textPath href="#gs-bot" startOffset="50%" textAnchor="middle">NO QUESTIONS ASKED</textPath>
      </text>

      {/* center mark */}
      <path d="M89 58 l7.5 7.5 15 -15" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <text x="100" y="116" textAnchor="middle" fill="#ffffff" fontSize="54" fontWeight="800" fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif">30</text>
      <text x="100" y="136" textAnchor="middle" fill="#ffffff" fontSize="14" fontWeight="700" letterSpacing="4">DAYS</text>
    </svg>
  );
}
