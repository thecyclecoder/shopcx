/**
 * Season + holiday awareness for the social scheduler.
 * See docs/brain/specs/automated-social-scheduler.md.
 *
 * Two jobs:
 *  - `isSeasonallyAppropriate(text, now)` — keep clearly off-season / wrong-
 *    holiday content (e.g. a July-4th or fall-chai resource) from auto-posting
 *    in the wrong month. Evergreen content (no seasonal signal) always passes.
 *  - `currentDateContext(now)` — a short date/season string fed into caption
 *    generation so copy never references the wrong season or holiday.
 */

type DayOfYearRange = { from: [number, number]; to: [number, number] }; // [month(1-12), day]

// Keyword → the window in which it's OK to post. Lead time is baked in (e.g.
// July-4th content is fine from late June). Windows that wrap the year (new
// year) are expressed with from > to and handled below.
const SEASONAL: { keywords: string[]; window: DayOfYearRange }[] = [
  { keywords: ["july 4", "july 4th", "fourth of july", "independence day", "4th of july"], window: { from: [6, 20], to: [7, 5] } },
  { keywords: ["memorial day"], window: { from: [5, 15], to: [5, 31] } },
  { keywords: ["labor day"], window: { from: [8, 20], to: [9, 7] } },
  { keywords: ["halloween", "spooky"], window: { from: [9, 25], to: [10, 31] } },
  { keywords: ["thanksgiving", "turkey day", "friendsgiving"], window: { from: [11, 1], to: [11, 30] } },
  { keywords: ["black friday", "cyber monday"], window: { from: [11, 20], to: [12, 2] } },
  { keywords: ["christmas", "xmas", "santa"], window: { from: [11, 25], to: [12, 26] } },
  { keywords: ["new year", "new year's", "nye", "resolution"], window: { from: [12, 26], to: [1, 15] } },
  { keywords: ["valentine"], window: { from: [1, 25], to: [2, 14] } },
  { keywords: ["easter"], window: { from: [3, 10], to: [4, 25] } },
  { keywords: ["mother's day", "mothers day"], window: { from: [4, 25], to: [5, 12] } },
  { keywords: ["father's day", "fathers day"], window: { from: [5, 30], to: [6, 18] } },
  { keywords: ["back to school", "back-to-school"], window: { from: [8, 1], to: [9, 15] } },
  { keywords: ["super bowl", "superbowl"], window: { from: [1, 25], to: [2, 12] } },
  // Seasons (broad). "fall/autumn/pumpkin/cozy/crisp fall" = autumn content.
  { keywords: ["pumpkin spice", "autumn", "crisp fall", "fall recipe", "cozy fall", "sweater weather"], window: { from: [9, 1], to: [11, 30] } },
  { keywords: ["summer", "beach", "poolside", "sunshine"], window: { from: [5, 15], to: [9, 5] } },
  { keywords: ["winter", "snow day", "hot cocoa"], window: { from: [11, 25], to: [2, 28] } },
  { keywords: ["spring", "blossom", "springtime"], window: { from: [3, 1], to: [5, 31] } },
];

function inWindow(now: Date, w: DayOfYearRange): boolean {
  const mmdd = (now.getMonth() + 1) * 100 + now.getDate();
  const from = w.from[0] * 100 + w.from[1];
  const to = w.to[0] * 100 + w.to[1];
  return from <= to ? (mmdd >= from && mmdd <= to) : (mmdd >= from || mmdd <= to); // wrap year
}

/**
 * True unless `text` carries a clear seasonal/holiday signal whose window does
 * NOT contain `now`. No seasonal signal → evergreen → true.
 */
export function isSeasonallyAppropriate(text: string, now: Date): boolean {
  const t = (text || "").toLowerCase();
  for (const s of SEASONAL) {
    if (s.keywords.some((k) => t.includes(k))) {
      return inWindow(now, s.window); // matched a season — only OK if in its window
    }
  }
  return true;
}

const SEASON_LABEL = (m: number) =>
  m <= 1 || m === 12 ? "winter" : m <= 4 ? "spring" : m <= 8 ? "summer" : "fall";

/** Short date/season context for caption prompts. Flags an imminent holiday. */
export function currentDateContext(now: Date): string {
  const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const season = SEASON_LABEL(now.getMonth() + 1);
  let holiday = "";
  for (const s of SEASONAL) {
    if (inWindow(now, s.window)) { holiday = s.keywords[0]; break; }
  }
  return `Today is ${dateStr} (${season}).${holiday ? ` Seasonally relevant: ${holiday}.` : ""} Do NOT reference any holiday or season that doesn't match today's date.`;
}
