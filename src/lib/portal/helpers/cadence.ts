/**
 * Render a billing interval + count pair as the customer-friendly
 * label the pricing rules use ("Monthly", "Every 2 Months", etc.).
 *
 * Mirrors the translateIntervals helper in playbook-executor.ts so
 * the portal, ticket replies, and operator scripts all read the same
 * language. When no friendly mapping exists, falls back to a
 * lowercase "every N weeks/months/days" sentence rather than the raw
 * "WEEK / 8" enum the Appstle webhook delivers.
 */
export function friendlyCadence(rawInterval: string | null | undefined, count: number | null | undefined): string {
  const interval = String(rawInterval || "").toUpperCase();
  const c = Number(count) || 1;

  if (interval === "WEEK") {
    if (c === 1) return "Weekly";
    if (c === 2) return "Twice a Month";
    if (c === 4) return "Monthly";
    if (c === 8) return "Every 2 Months";
    if (c === 12) return "Every 3 Months";
    return `Every ${c} weeks`;
  }
  if (interval === "MONTH") {
    if (c === 1) return "Monthly";
    if (c === 2) return "Every 2 Months";
    if (c === 3) return "Every 3 Months";
    if (c === 6) return "Every 6 Months";
    return `Every ${c} months`;
  }
  if (interval === "DAY") {
    if (c === 7) return "Weekly";
    if (c === 14) return "Every 2 Weeks";
    if (c === 28 || c === 30) return "Monthly";
    if (c === 60) return "Every 2 Months";
    if (c === 90) return "Every 3 Months";
    return `Every ${c} days`;
  }
  // Unknown interval — fall through to the literal phrasing rather
  // than swallowing it. Surfaces unexpected backend states to the
  // customer in plain English instead of the raw enum.
  return `Every ${c} ${(rawInterval || "cycle").toLowerCase()}${c > 1 ? "s" : ""}`;
}
