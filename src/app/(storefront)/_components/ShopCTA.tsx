import { ShieldIcon, TrustBadge } from "./TrustBadge";

/**
 * The one CTA component for the entire storefront.
 *
 * Every "buy this" button on the page renders through this — hero,
 * mid-section prompts, final CTA, per-tier "Add to cart" buttons in
 * the price table. Edit it here and every CTA on every page updates.
 *
 * Variants:
 *   primary  — white text on the workspace primary color (default).
 *              Use on light/white backgrounds.
 *   inverse  — primary-colored text on white. Use on a colored hero/
 *              dark background section like FinalCTA, or as the
 *              non-highlighted button inside a price card.
 *
 * Sizes:
 *   default  — h-16 pill, the big page-level CTA. Use everywhere you
 *              want it to read as the section's destination.
 *   compact  — h-12 pill, smaller text. Use inside a price card or
 *              anywhere the button is one of several stacked actions.
 *
 * Button hugs the copy at every breakpoint with a min-width floor so
 * the tap target stays comfortable. Wrapper centers/aligns it; we
 * don't size the button to its parent.
 */
export function ShopCTA({
  href = "#pricing",
  label,
  lowestPriceCents,
  variant = "primary",
  size = "default",
  showTrust = true,
  align = "center",
  className = "",
  dataAttributes,
}: {
  href?: string;
  label?: string;
  lowestPriceCents?: number | null;
  variant?: "primary" | "inverse";
  size?: "default" | "compact";
  showTrust?: boolean;
  align?: "center" | "start";
  className?: string;
  /**
   * Extra data-* attributes attached to the anchor. Used by the price
   * table to encode the variant id + mode + frequency so the cart
   * handler can identify which tier was clicked.
   */
  dataAttributes?: Record<string, string | number | null | undefined>;
}) {
  const resolvedLabel = label
    || (lowestPriceCents != null
      ? `Shop now — from $${(lowestPriceCents / 100).toFixed(2)}`
      : "Shop now");

  const isPrimary = variant === "primary";
  const isCompact = size === "compact";

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

  // Size-driven sizing. Default = page-level hero pill. Compact =
  // inside-a-card pill, smaller text + height + min-width.
  const sizeClasses = isCompact
    ? "h-12 min-w-[200px] px-6 text-base sm:min-w-[220px]"
    : "h-16 min-w-[280px] px-10 text-xl sm:min-w-[320px]";

  const baseClasses = "group inline-flex items-center justify-center gap-2 rounded-full font-extrabold uppercase tracking-wide shadow-lg shadow-black/10 transition-[transform,filter,box-shadow,colors] hover:scale-[1.02] active:scale-[0.98]";
  const buttonClasses = isPrimary
    ? `${baseClasses} ${sizeClasses} text-white ring-1 ring-inset ring-white/10 hover:brightness-110`
    : `${baseClasses} ${sizeClasses} bg-white hover:bg-zinc-50`;

  const inverseColorStyle = !isPrimary
    ? { color: "var(--storefront-primary)", fontFamily: "var(--storefront-heading-font)" }
    : undefined;

  // On mobile the button is content-width like desktop now, so the
  // trust badge looks best centered beneath it regardless of section
  // alignment. On desktop we respect the section's `align` setting.
  const desktopItemsClass = align === "center" ? "sm:items-center" : "sm:items-start";

  // Build data-* attribute set — filter out empty values so we don't
  // emit `data-x=""` on every button by default.
  const dataAttrs: Record<string, string> = {};
  if (dataAttributes) {
    for (const [k, v] of Object.entries(dataAttributes)) {
      if (v != null && String(v) !== "") dataAttrs[`data-${k}`] = String(v);
    }
  }

  return (
    <div className={`flex flex-col items-center gap-3 ${desktopItemsClass} ${className}`}>
      <a
        href={href}
        style={isPrimary ? buttonStyle : inverseColorStyle}
        className={buttonClasses}
        {...dataAttrs}
      >
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
