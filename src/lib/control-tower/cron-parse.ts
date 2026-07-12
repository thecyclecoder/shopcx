/**
 * Control Tower — pure cron-expression parsing helpers.
 *
 * Split out from [[./monitor]] so the registry can use them for its build-time
 * invariants (monitor-cadence-scaled-liveness-window Phase 1) without importing
 * monitor.ts (which imports the registry — the cycle would leave the bootstrap
 * block reading `extractCronExpr` before monitor.ts had finished loading).
 *
 * These are pure, allocation-only helpers — no I/O, no clock reads, no
 * registry knowledge. `monitor.ts` re-exports them for existing callers.
 */

/**
 * Pull the 5-field cron expression out of the human-readable `expectedCadence`
 * string carried by a MonitoredLoop (e.g. `"daily (0 4 * * *)"`). Returns `null`
 * for cadences that are not backed by an Inngest cron (`"box job"`, `"polls every ~5s"`).
 */
export function extractCronExpr(cadence: string): string | null {
  const m = cadence.match(/\(([\d*/,\- ]+)\)/);
  if (!m) return null;
  const expr = m[1].trim();
  if (expr.split(/\s+/).length !== 5) return null;
  return expr;
}

export interface CronSets {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) return null;
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((s) => parseInt(s, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      start = a;
      end = b;
    } else {
      const v = parseInt(range, 10);
      if (!Number.isFinite(v)) return null;
      start = v;
      // Vixie cron: a literal-with-step ("5/15") means "5,20,35,…" up to max.
      end = stepStr ? max : v;
    }
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) result.add(v);
  }
  return result;
}

export function parseCronExpr(expr: string): CronSets | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const ranges: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const out: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const set = parseCronField(parts[i], ranges[i][0], ranges[i][1]);
    if (!set) return null;
    out.push(set);
  }
  return { minute: out[0], hour: out[1], dayOfMonth: out[2], month: out[3], dayOfWeek: out[4] };
}

/**
 * Mean interval between firings of a parsed cron expression, in ms —
 * used by [[./registry]] `assertRegistryInvariants` to check that a loop's
 * `livenessWindowMs` is wide enough to accommodate its cadence (window >=
 * cadence * jitter grace). Derived directly from the parsed cron structure
 * rather than by iterating firing timestamps so it stays cheap and works for
 * monthly / yearly cadences that a minute-walk approach can't span.
 *
 * Approximation notes:
 *   - Month is treated as 30 days (day-of-month restricted crons).
 *   - Day-of-month "31" is size 31 (parseCronField expands `*` to 1..31),
 *     which slightly under-counts months with 28/29/30 days — fine for a
 *     ±20% jitter-grace check.
 *   - Standard Vixie cron OR-semantic (both DOM and DOW restricted) is
 *     approximated as the union of firings from each axis.
 */
export function meanCadenceMsFromSets(sets: CronSets): number {
  const MS_PER_DAY = 24 * 60 * 60_000;
  const firingsPerMatchingDay = sets.minute.size * sets.hour.size;
  if (firingsPerMatchingDay <= 0) return Number.POSITIVE_INFINITY;
  const domRestricted = sets.dayOfMonth.size !== 31;
  const dowRestricted = sets.dayOfWeek.size !== 7;
  let matchingDaysPerPeriodMs: number;
  let periodMs: number;
  if (!domRestricted && !dowRestricted) {
    // Fires every day.
    matchingDaysPerPeriodMs = 1;
    periodMs = MS_PER_DAY;
  } else if (dowRestricted && !domRestricted) {
    // Weekly-shape: fires on a subset of weekdays.
    matchingDaysPerPeriodMs = sets.dayOfWeek.size;
    periodMs = 7 * MS_PER_DAY;
  } else if (domRestricted && !dowRestricted) {
    // Monthly-shape: fires on specific days of the (30-day approximation) month.
    matchingDaysPerPeriodMs = sets.dayOfMonth.size;
    periodMs = 30 * MS_PER_DAY;
  } else {
    // Both restricted — Vixie cron uses OR semantic. Approximate as the union
    // per week: DOW count directly + DOM count scaled to a week.
    matchingDaysPerPeriodMs = sets.dayOfWeek.size + (sets.dayOfMonth.size * 7) / 30;
    periodMs = 7 * MS_PER_DAY;
  }
  const totalFiringsPerPeriod = matchingDaysPerPeriodMs * firingsPerMatchingDay;
  if (totalFiringsPerPeriod <= 0) return Number.POSITIVE_INFINITY;
  return periodMs / totalFiringsPerPeriod;
}
