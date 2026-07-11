/**
 * central-day — the workspace's "which calendar day is it" boundary, in US Central.
 *
 * The workspace runs on Central time (`WORKSPACE_TZ` in [[sms-marketing-agent]], the Central date in
 * [[ai-date-context]]). But server code runs on Vercel in **UTC**, so the naive
 * `new Date(); d.setHours(0,0,0,0)` computes a UTC-midnight boundary — which at 9 PM Central (already
 * past midnight UTC) snaps "today" to TOMORROW's UTC date. That off-by-one is what made the AI-analysis
 * dashboard read 7/11 (and scoop a full UTC day of tickets into 7/10's detail) on the evening of 7/10.
 *
 * These helpers anchor every day boundary to the Central calendar day instead, DST-safe (the offset is
 * read from the zone at the instant, not hardcoded), and dependency-free.
 */

export const CENTRAL_TZ = "America/Chicago";

/** The offset (zone-wall-clock − UTC) in ms at `instant` for `timeZone`. DST-correct. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  // The zone's wall-clock at `instant`, read as if it were a UTC timestamp.
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return asUtc - instant.getTime();
}

/** The Central calendar date ("YYYY-MM-DD") for an instant (Date or ISO string). */
export function centralDateStr(d: Date | string): string {
  const instant = typeof d === "string" ? new Date(d) : d;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Today's Central calendar date ("YYYY-MM-DD"). */
export function centralTodayStr(now: Date = new Date()): string {
  return centralDateStr(now);
}

/**
 * The UTC instant (ISO) of Central midnight that STARTS the given Central calendar day.
 * e.g. `centralDayStartUtcIso("2026-07-10")` → the ISO for 2026-07-10 00:00 Central (05:00Z in CDT).
 */
export function centralDayStartUtcIso(dateStr: string): string {
  // Naive "wall-clock midnight" as a UTC timestamp, then shift by the zone's offset at that instant so
  // the RESULT's Central wall-clock reads exactly dateStr 00:00:00.
  const naive = new Date(`${dateStr}T00:00:00Z`).getTime();
  const offset = tzOffsetMs(new Date(naive), CENTRAL_TZ);
  return new Date(naive - offset).toISOString();
}

/** {start, end} UTC ISO instants bounding a Central calendar day [dateStr 00:00, next-day 00:00). */
export function centralDayWindowUtc(dateStr: string): { start: string; end: string } {
  const start = centralDayStartUtcIso(dateStr);
  // Add ~26h to the start then re-anchor to the NEXT Central day's midnight — robust across the
  // 23h/25h DST-transition days (a fixed +24h would land an hour off on those two days a year).
  const nextDay = centralDateStr(new Date(new Date(start).getTime() + 26 * 60 * 60 * 1000));
  const end = centralDayStartUtcIso(nextDay);
  return { start, end };
}

/** The UTC instant (ISO) of Central midnight that starts TODAY (Central). */
export function centralTodayStartUtcIso(now: Date = new Date()): string {
  return centralDayStartUtcIso(centralTodayStr(now));
}
