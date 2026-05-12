/**
 * Compact, horizontally-scrollable row of pill chips for trust
 * signals. Pulls double duty:
 *   - Certifications (Non-GMO, 3rd Party Tested, Made in USA, USDA
 *     Organic) — each gets a green check.
 *   - Allergen-free claims (Gluten Free, Dairy Free, Soy Free, Sugar
 *     Free) — each gets a strikethrough/no-circle icon.
 *
 * Direct-response placement: under the hero (eye-line at the buying
 * decision), again above the price table (right before conversion).
 * Compact enough that it doesn't compete with the headline; obvious
 * enough that a skimmer sees "passes all my filters" instantly.
 */
export function TrustChipRow({
  certifications,
  allergenFree,
  variant = "light",
  align = "start",
  className = "",
}: {
  certifications?: string[] | null;
  allergenFree?: string[] | null;
  variant?: "light" | "dark";
  align?: "start" | "center";
  className?: string;
}) {
  const certs = (certifications || []).filter((s) => s && s.trim());
  const allergens = (allergenFree || []).filter((s) => s && s.trim());
  if (certs.length === 0 && allergens.length === 0) return null;

  const isDark = variant === "dark";
  const chipClass = isDark
    ? "inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white sm:text-sm"
    : "inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-700 sm:text-sm";
  const checkColor = isDark ? "text-emerald-300" : "text-emerald-600";
  const xColor = isDark ? "text-rose-300" : "text-rose-500";

  return (
    <ul
      className={`flex flex-wrap gap-2 ${align === "center" ? "justify-center" : ""} ${className}`}
    >
      {certs.map((label, i) => (
        <li key={`c-${i}`} className={chipClass}>
          <CheckIcon className={checkColor} />
          {label}
        </li>
      ))}
      {allergens.map((label, i) => (
        <li key={`a-${i}`} className={chipClass}>
          <NoCircleIcon className={xColor} />
          {label}
        </li>
      ))}
    </ul>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function NoCircleIcon({ className = "" }: { className?: string }) {
  // Universal "no" symbol — circle with a diagonal slash. Reads as
  // "no [allergen]" without language, works for any locale.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="5.5" y1="5.5" x2="18.5" y2="18.5" />
    </svg>
  );
}
