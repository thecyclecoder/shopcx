import { ShieldIcon, TrustBadge } from "./TrustBadge";

/**
 * Reusable storefront CTA — the canonical "Shop now" pill button with
 * the 30-day money-back trust line beneath. Use this everywhere a CTA
 * appears (hero, why-it-works, final CTA, etc.) so the prompt looks
 * identical throughout the page.
 *
 * Variants:
 *   primary  — white text on the workspace primary color (default).
 *              Use on light/white backgrounds.
 *   inverse  — primary-colored text on white. Use on a colored hero/
 *              dark background section like FinalCTA.
 *
 * Mobile: full-width (`w-full`). Desktop sm+: shrinks to content (`sm:w-auto`).
 * If `align="center"` (default), the trust line centers under the button.
 */
export function ShopCTA({
  href = "#pricing",
  label,
  lowestPriceCents,
  variant = "primary",
  showTrust = true,
  align = "center",
  className = "",
}: {
  href?: string;
  label?: string;
  lowestPriceCents?: number | null;
  variant?: "primary" | "inverse";
  showTrust?: boolean;
  align?: "center" | "start";
  className?: string;
}) {
  const resolvedLabel = label
    || (lowestPriceCents != null
      ? `Shop now — from $${(lowestPriceCents / 100).toFixed(2)}`
      : "Shop now");

  const isPrimary = variant === "primary";
  // Gradient pulls from a lighter shade of the workspace primary to
  // a noticeably darker one — color-mix preserves the hue so any
  // workspace color works. Three stops + a 145° angle give a real
  // glossy sheen rather than the previous subtle drift.
  const buttonStyle = isPrimary
    ? {
        background:
          "linear-gradient(145deg, color-mix(in srgb, var(--storefront-primary), white 14%) 0%, var(--storefront-primary) 45%, color-mix(in srgb, var(--storefront-primary), black 38%) 100%)",
        fontFamily: "var(--storefront-heading-font)",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.30), 0 0 1px rgba(0, 0, 0, 0.15)",
      }
    : { fontFamily: "var(--storefront-heading-font)" };
  const buttonClasses = isPrimary
    ? "group inline-flex h-16 w-full items-center justify-center gap-2 rounded-full px-8 text-xl font-extrabold uppercase tracking-wide text-white shadow-lg shadow-black/10 ring-1 ring-inset ring-white/10 transition-[transform,filter,box-shadow] hover:scale-[1.02] hover:brightness-110 active:scale-[0.98] sm:w-auto sm:min-w-[300px]"
    : "group inline-flex h-16 w-full items-center justify-center gap-2 rounded-full bg-white px-8 text-xl font-extrabold uppercase tracking-wide shadow-lg shadow-black/10 transition-[transform,colors] hover:scale-[1.02] hover:bg-zinc-50 active:scale-[0.98] sm:w-auto sm:min-w-[300px]";
  const inverseColorStyle = !isPrimary
    ? { color: "var(--storefront-primary)", fontFamily: "var(--storefront-heading-font)" }
    : undefined;

  // On mobile the button is always full-width, so the trust badge
  // looks best centered beneath it regardless of section alignment.
  // On desktop we respect the section's `align` setting so the badge
  // tucks under the (content-width) button.
  const desktopItemsClass = align === "center" ? "sm:items-center" : "sm:items-start";

  return (
    <div className={`flex flex-col items-center gap-3 ${desktopItemsClass} ${className}`}>
      <a href={href} style={isPrimary ? buttonStyle : inverseColorStyle} className={buttonClasses}>
        <span>{resolvedLabel}</span>
        {/* Inline SVG double-chevron — using a Unicode » never aligned
            cleanly against uppercase Montserrat caps because that
            glyph anchors to x-height. SVG lets us size to font
            cap-height and position it pixel-perfect at the center
            of the line-box. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="1em"
          height="1em"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="inline-block flex-shrink-0 transition-transform duration-200 group-hover:translate-x-1"
          style={{ marginTop: "0.05em" }}
        >
          <polyline points="6,5 14,12 6,19" />
          <polyline points="13,5 21,12 13,19" />
        </svg>
      </a>
      {showTrust && (
        <TrustBadge icon={<ShieldIcon />} label="30-day money-back" />
      )}
    </div>
  );
}
