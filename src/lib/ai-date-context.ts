/**
 * Standardized "current date" context block to inject into AI prompts.
 *
 * Claude models have training cutoffs in the past. Without explicitly
 * being told what today's date is, they sometimes reason from a stale
 * baseline — e.g. miscalculating "expires in June 2026" as 13 months
 * out when it's actually 1 month from today's actual May 2026.
 *
 * Drop this block into any AI prompt that involves date math, timeline
 * analysis, or temporal reasoning (orders, expirations, subscriptions,
 * messages, returns, etc).
 */
export function currentDateContext(): string {
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const todayLong = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });
  return `TODAY'S DATE: ${todayIso} (${todayLong}, Central time).
Use this exact date for any date math — never guess. When you see a date in customer messages, orders, subscriptions, or events, compute gaps relative to TODAY above, not relative to your training cutoff.`;
}
