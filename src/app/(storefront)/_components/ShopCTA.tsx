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
  const buttonStyle = isPrimary
    ? { backgroundColor: "var(--storefront-primary)" }
    : undefined;
  const buttonClasses = isPrimary
    ? "inline-flex h-14 w-full items-center justify-center rounded-full px-8 text-base font-semibold text-white shadow-sm transition-[filter] hover:brightness-90 sm:w-auto sm:min-w-[280px]"
    : "inline-flex h-14 w-full items-center justify-center rounded-full bg-white px-8 text-base font-semibold transition-colors hover:bg-zinc-100 sm:w-auto sm:min-w-[280px]";
  const inverseTextStyle = !isPrimary ? { color: "var(--storefront-primary)" } : undefined;

  const wrapperAlign = align === "center" ? "items-center" : "items-start";

  return (
    <div className={`flex flex-col gap-3 ${wrapperAlign} ${className}`}>
      <a href={href} style={buttonStyle ?? inverseTextStyle} className={buttonClasses}>
        {resolvedLabel}
      </a>
      {showTrust && (
        <TrustBadge icon={<ShieldIcon />} label="30-day money-back" />
      )}
    </div>
  );
}
