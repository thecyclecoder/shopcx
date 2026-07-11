# libraries/central-day

The workspace's **"which calendar day is it"** boundary, anchored to **US Central** (`America/Chicago`) instead of the server's UTC clock.

**File:** `src/lib/central-day.ts`

## Why

Server code runs on Vercel in **UTC**. The naive `new Date(); d.setHours(0,0,0,0)` therefore computes a **UTC-midnight** boundary — and at ~7 PM+ Central (already past midnight UTC) that rolls "today" to TOMORROW's date. On the evening of 2026-07-10 the AI-analysis dashboard read **7/11** and its day-detail scooped a full extra UTC-evening slice of tickets, because the boundary was UTC, not Central. This module fixes that class of bug once: anchor every day boundary to the Central calendar day, matching the rest of the app's "which day is it" convention (`WORKSPACE_TZ` in [[sms-marketing-agent]], the Central date in [[ai-date-context]]).

DST-safe: the zone offset is read from `Intl.DateTimeFormat` at the instant (correct across the 23h/25h transition days), not hardcoded. Dependency-free.

## Exports

- `CENTRAL_TZ` — `"America/Chicago"`.
- `centralDateStr(d: Date | string)` → `"YYYY-MM-DD"` — the Central calendar date for an instant. Use this for **bucketing** instead of `iso.slice(0,10)` (which buckets by UTC day).
- `centralTodayStr(now?)` → `"YYYY-MM-DD"` — today's Central date.
- `centralDayStartUtcIso(dateStr)` → ISO — the UTC instant of Central midnight that STARTS the given Central day (e.g. `"2026-07-10"` → `2026-07-10T05:00:00.000Z` in CDT).
- `centralDayWindowUtc(dateStr)` → `{ start, end }` — the `[00:00, next-00:00)` UTC instants bounding a Central day; DST-safe (23h/25h on transition days).
- `centralTodayStartUtcIso(now?)` → ISO — Central midnight that starts TODAY, as a UTC instant. The `gte` bound for a "so far today" query.

## Callers

- [[../dashboard/ai-analysis]] `src/app/api/workspaces/[id]/ticket-analyses/route.ts` — all three views: `today` (`gte centralTodayStartUtcIso`), `tickets&date=` (bounds by `centralDayWindowUtc` + buckets by `centralDateStr`), and the `daily` rollup (buckets by `centralDateStr`).

## Related

- [[sms-marketing-agent]] — `WORKSPACE_TZ = "America/Chicago"`, the same "which calendar day is it" tz.
- [[ai-date-context]] — injects TODAY's Central date into agent prompts.

---

[[../README]] · [[../../CLAUDE]]
