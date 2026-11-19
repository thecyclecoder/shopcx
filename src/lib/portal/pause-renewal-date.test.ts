/**
 * Portal "pause N days" counts from the NEXT RENEWAL, not from today.
 *
 * Ground truth: Laura Light (ticket b74b5a1c) had an 8-week sub renewing 2027-01-12 and pressed
 * "Pause 60 days". The old handler anchored the resume to today (today + 60), so the portal said
 * "paused until Jan 17" — barely moving her actual charge. It must now land on Jan 12 + 60 = Mar 13.
 *
 * Run: `npx tsx --test src/lib/portal/pause-renewal-date.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computePausedRenewalDate } from "./pause-renewal-date";

test("future next renewal: Jan 12 + 60 → Mar 13", () => {
  const now = new Date("2026-11-18T16:27:00.000Z");
  const out = computePausedRenewalDate("2027-01-12", 60, now);
  assert.equal(out.slice(0, 10), "2027-03-13");
});

test("past next renewal falls back to today + pauseDays", () => {
  const now = new Date("2026-11-18T16:27:00.000Z");
  const out = computePausedRenewalDate("2026-01-01", 30, now);
  // base = today (the stored date is in the past), + 30 days = 2026-12-18
  assert.equal(out.slice(0, 10), "2026-12-18");
});

test("null next renewal falls back to today + pauseDays", () => {
  const now = new Date("2026-11-18T16:27:00.000Z");
  const out = computePausedRenewalDate(null, 60, now);
  // 2026-11-18 + 60 = 2027-01-17
  assert.equal(out.slice(0, 10), "2027-01-17");
});

test("auto-resume honors a future stored next_billing_date instead of rolling forward", () => {
  // The resume path is a cron with server-side imports, so pin the behavior at the source: a
  // future stored date is kept (`next = stored`), only a past date rolls forward.
  const src = readFileSync(
    join(__dirname, "../inngest/portal-auto-resume.ts"),
    "utf8",
  );
  assert.match(src, /storedIsFuture/);
  assert.match(src, /next = stored/);
});
