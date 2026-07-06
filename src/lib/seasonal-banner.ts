/**
 * Seasonal / holiday-aware promo banner text — a REUSABLE, pure, isomorphic utility.
 *
 * Landers are edge-cached (static), so a server-rendered promo banner would freeze the
 * "season" at cache time. Instead a caller runs this CLIENT-SIDE with the visitor's own
 * `new Date()` and drops the result into a FIXED-HEIGHT banner after load — so a cached page
 * always resolves to the visitor's real date (evergreen) with zero layout shift.
 *
 * Usage (any page/lander — pass your own discount + base offer line):
 *   seasonalBannerText({ discount: "65% OFF", base: "+ Free Welcome Kit \u{1F381}" })
 *     // Jul 6 →  "4th of July Sale Ends Soon — 65% OFF + Free Welcome Kit 🎁"
 *     // Jul 20 → "Summer Sale Ends Soon — 65% OFF + Free Welcome Kit 🎁"
 *
 * `resolveOccasion(date)` is the reusable brain (returns "4th of July Sale" | "Summer Sale" | …);
 * the composer just wraps it with the caller's discount + base line. Floating holidays
 * (Memorial/Labor/Thanksgiving/Presidents'/Mother's/Father's) are COMPUTED each year, not
 * hardcoded, so the calendar never needs maintenance.
 */

/** n-th (1-based) `weekday` (0=Sun … 6=Sat) of `month` (0-based) in `year`. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + offset + (n - 1) * 7);
}

/** Last `weekday` (0=Sun … 6=Sat) of `month` (0-based) in `year`. */
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - offset);
}

/** Inclusive day-of-year window test, ignoring time-of-day. */
function within(d: Date, start: Date, end: Date): boolean {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return day >= new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime() &&
    day <= new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
}

const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** One occasion: a label + a predicate over the visitor's date. Ordered by PRIORITY — the
 *  first holiday whose window contains `d` wins; the season fallback is last. */
interface OccasionRule {
  label: string;
  match: (d: Date) => boolean;
}

/**
 * The occasion calendar. Holidays override the season fallback; each holiday is a ~week
 * window leading up to the day. Floating holidays are computed from `d`'s own year so they
 * stay correct forever. Edit this one array to add/remove occasions.
 */
export const OCCASION_CALENDAR: OccasionRule[] = [
  { label: "New Year's Sale", match: (d) => within(d, new Date(d.getFullYear(), 11, 27), new Date(d.getFullYear(), 11, 31)) || within(d, new Date(d.getFullYear(), 0, 1), new Date(d.getFullYear(), 0, 2)) },
  { label: "Valentine's Day Sale", match: (d) => within(d, new Date(d.getFullYear(), 1, 8), new Date(d.getFullYear(), 1, 14)) },
  { label: "Presidents' Day Sale", match: (d) => { const h = nthWeekday(d.getFullYear(), 1, 1, 3); return within(d, addDays(h, -4), addDays(h, 1)); } },
  { label: "St. Patrick's Day Sale", match: (d) => within(d, new Date(d.getFullYear(), 2, 13), new Date(d.getFullYear(), 2, 17)) },
  { label: "Mother's Day Sale", match: (d) => { const h = nthWeekday(d.getFullYear(), 4, 0, 2); return within(d, addDays(h, -6), h); } },
  { label: "Memorial Day Sale", match: (d) => { const h = lastWeekday(d.getFullYear(), 4, 1); return within(d, addDays(h, -6), h); } },
  { label: "Father's Day Sale", match: (d) => { const h = nthWeekday(d.getFullYear(), 5, 0, 3); return within(d, addDays(h, -6), h); } },
  { label: "4th of July Sale", match: (d) => within(d, new Date(d.getFullYear(), 5, 29), new Date(d.getFullYear(), 6, 6)) },
  // Prime Day is Amazon-set (mid-July, varies); we piggyback with an approximate window after the 4th.
  { label: "Prime Day Sale", match: (d) => within(d, new Date(d.getFullYear(), 6, 8), new Date(d.getFullYear(), 6, 17)) },
  { label: "Labor Day Sale", match: (d) => { const h = nthWeekday(d.getFullYear(), 8, 1, 1); return within(d, addDays(h, -6), h); } },
  { label: "Halloween Sale", match: (d) => within(d, new Date(d.getFullYear(), 9, 25), new Date(d.getFullYear(), 9, 31)) },
  // Thanksgiving = 4th Thursday of Nov. Black Friday = Thu+1 through Sun; Cyber Monday = the following Mon.
  { label: "Black Friday Sale", match: (d) => { const t = nthWeekday(d.getFullYear(), 10, 4, 4); return within(d, addDays(t, 1), addDays(t, 3)); } },
  { label: "Cyber Monday Sale", match: (d) => { const t = nthWeekday(d.getFullYear(), 10, 4, 4); return within(d, addDays(t, 4), addDays(t, 4)); } },
  { label: "Holiday Sale", match: (d) => within(d, new Date(d.getFullYear(), 11, 10), new Date(d.getFullYear(), 11, 24)) },
];

/** Meteorological season fallback when no holiday window matches. */
function seasonLabel(d: Date): string {
  const m = d.getMonth();
  if (m <= 1 || m === 11) return "Winter Sale";
  if (m <= 4) return "Spring Sale";
  if (m <= 7) return "Summer Sale";
  return "Fall Sale";
}

/** The reusable brain: the current occasion label for `now` (holiday window → else season). */
export function resolveOccasion(now: Date = new Date()): string {
  for (const rule of OCCASION_CALENDAR) if (rule.match(now)) return rule.label;
  return seasonLabel(now);
}

export interface SeasonalBannerOpts {
  /** The discount headline, e.g. "65% OFF". */
  discount: string;
  /** The static offer tail, e.g. "+ Free Welcome Kit 🎁". */
  base: string;
  /** Urgency phrase after the occasion. Default "Ends Soon". */
  urgency?: string;
  /** Visitor date — pass the CLIENT's `new Date()` for evergreen behavior. */
  now?: Date;
}

/**
 * Compose the full banner string: `{Occasion} Sale Ends Soon — {discount} {base}`.
 * (The occasion label already ends in "Sale", so we only append the urgency + offer.)
 */
export function seasonalBannerText({ discount, base, urgency = "Ends Soon", now = new Date() }: SeasonalBannerOpts): string {
  const occasion = resolveOccasion(now);
  return `${occasion} ${urgency} — ${discount} ${base}`.replace(/\s+/g, " ").trim();
}
