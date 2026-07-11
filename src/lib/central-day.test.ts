/**
 * Pins the Central-calendar-day boundary helpers ([[central-day]]) — the fix for the AI-analysis
 * dashboard reading the wrong day (7/11 with a full extra UTC day of tickets) on the evening of 7/10,
 * because the boundary was computed on the Vercel server's UTC clock instead of US Central.
 *
 * Run: npx tsx --test src/lib/central-day.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  centralDateStr,
  centralTodayStr,
  centralDayStartUtcIso,
  centralDayWindowUtc,
  centralTodayStartUtcIso,
} from "./central-day";

test("centralDateStr: 9:14 PM CDT July 10 (= 02:14Z July 11) is still July 10 in Central", () => {
  // 2026-07-10 21:14 America/Chicago (CDT, UTC-5) = 2026-07-11 02:14Z.
  assert.equal(centralDateStr("2026-07-11T02:14:00.000Z"), "2026-07-10");
});

test("centralDateStr: the exact UTC-midnight rollover is still 'yesterday' in Central", () => {
  // 2026-07-11 00:00Z = 2026-07-10 19:00 CDT — the naive UTC .slice(0,10) bug would call this 7/11.
  assert.equal(centralDateStr("2026-07-11T00:00:00.000Z"), "2026-07-10");
});

test("centralDayStartUtcIso: CDT (summer) midnight is 05:00Z", () => {
  assert.equal(centralDayStartUtcIso("2026-07-10"), "2026-07-10T05:00:00.000Z");
});

test("centralDayStartUtcIso: CST (winter) midnight is 06:00Z", () => {
  assert.equal(centralDayStartUtcIso("2026-01-15"), "2026-01-15T06:00:00.000Z");
});

test("centralDayWindowUtc: a normal summer day is [05:00Z, next 05:00Z)", () => {
  const { start, end } = centralDayWindowUtc("2026-07-10");
  assert.equal(start, "2026-07-10T05:00:00.000Z");
  assert.equal(end, "2026-07-11T05:00:00.000Z");
});

test("centralDayWindowUtc: spring-forward day is only 23h wide (DST-safe, not a fixed +24h)", () => {
  // 2026 US DST starts Sun Mar 8. That Central day runs 06:00Z → next-day 05:00Z = 23 hours.
  const { start, end } = centralDayWindowUtc("2026-03-08");
  assert.equal(start, "2026-03-08T06:00:00.000Z"); // CST midnight
  assert.equal(end, "2026-03-09T05:00:00.000Z"); // CDT midnight
  assert.equal((new Date(end).getTime() - new Date(start).getTime()) / 3_600_000, 23);
});

test("centralDayWindowUtc: fall-back day is 25h wide", () => {
  // 2026 US DST ends Sun Nov 1. That Central day runs 05:00Z → next-day 06:00Z = 25 hours.
  const { start, end } = centralDayWindowUtc("2026-11-01");
  assert.equal((new Date(end).getTime() - new Date(start).getTime()) / 3_600_000, 25);
});

test("centralTodayStartUtcIso(now) is the Central-midnight instant of centralTodayStr(now)", () => {
  const now = new Date("2026-07-11T02:14:00.000Z"); // 9:14 PM CDT July 10
  assert.equal(centralTodayStr(now), "2026-07-10");
  assert.equal(centralTodayStartUtcIso(now), "2026-07-10T05:00:00.000Z");
});
