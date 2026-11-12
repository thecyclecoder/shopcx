/**
 * Unit tests for the software-mode live-hours handoff pure helpers.
 *
 * Spec: software-mode-live-hours-handoff. Covers `isWithinLiveHours` (IANA tz, days 0=Sun,
 * HH:MM bounds, overnight windows, null/malformed = never live), `normalizeSupportLiveHours`,
 * `isSoftwareModeWorkspace`, and `softwareHandoffReply`. No DB — the routing helper's DB writes
 * live in action-executor's escalate path.
 *
 * Run: npx tsx --test src/lib/support-mode.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWithinLiveHours,
  normalizeSupportLiveHours,
  isSoftwareModeWorkspace,
  softwareHandoffReply,
  MANAGED_SUPPORT_WORKSPACE_ID,
  type SupportLiveHours,
} from "@/lib/support-mode";

const MON_FRI_9_5: SupportLiveHours = {
  tz: "America/New_York",
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:00",
};

test("null / undefined config is never live (always the email promise)", () => {
  assert.equal(isWithinLiveHours(null, new Date()), false);
  assert.equal(isWithinLiveHours(undefined, new Date()), false);
});

test("inside the window on an active weekday → live", () => {
  // 2026-11-12 is a Thursday. 14:00 America/New_York → 19:00Z (EST, UTC-5).
  const now = new Date("2026-11-12T19:00:00Z");
  assert.equal(isWithinLiveHours(MON_FRI_9_5, now), true);
});

test("before the window opens on an active weekday → not live", () => {
  // 08:00 ET on Thursday → 13:00Z.
  const now = new Date("2026-11-12T13:00:00Z");
  assert.equal(isWithinLiveHours(MON_FRI_9_5, now), false);
});

test("after the window closes on an active weekday → not live", () => {
  // 17:00 ET (end is exclusive) on Thursday → 22:00Z.
  const now = new Date("2026-11-12T22:00:00Z");
  assert.equal(isWithinLiveHours(MON_FRI_9_5, now), false);
});

test("inside the clock window but on an inactive day (Sunday) → not live", () => {
  // 2026-11-15 is a Sunday. 14:00 ET → 19:00Z. Sunday (0) is not in days.
  const now = new Date("2026-11-15T19:00:00Z");
  assert.equal(isWithinLiveHours(MON_FRI_9_5, now), false);
});

test("day boundary respects the config tz, not UTC", () => {
  // 2026-11-16 00:30Z is Monday in UTC but still Sunday 19:30 ET → inactive Sunday.
  const now = new Date("2026-11-16T00:30:00Z");
  assert.equal(isWithinLiveHours(MON_FRI_9_5, now), false);
});

test("overnight window (22:00–02:00) matches after start on its start day", () => {
  const overnight: SupportLiveHours = { tz: "UTC", days: [5], start: "22:00", end: "02:00" };
  // Friday 23:00 UTC → inside (after start, start-day Friday active).
  assert.equal(isWithinLiveHours(overnight, new Date("2026-11-13T23:00:00Z")), true);
  // Saturday 01:00 UTC → inside (before end, belongs to Friday's window).
  assert.equal(isWithinLiveHours(overnight, new Date("2026-11-14T01:00:00Z")), true);
  // Saturday 23:00 UTC → not live (Saturday is not a start day).
  assert.equal(isWithinLiveHours(overnight, new Date("2026-11-14T23:00:00Z")), false);
  // Friday 21:00 UTC → not live (before window opens).
  assert.equal(isWithinLiveHours(overnight, new Date("2026-11-13T21:00:00Z")), false);
});

test("zero-length window (start === end) is never live", () => {
  const zero: SupportLiveHours = { tz: "UTC", days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "09:00" };
  assert.equal(isWithinLiveHours(zero, new Date("2026-11-12T09:00:00Z")), false);
});

test("malformed bounds / tz → not live (fail closed)", () => {
  assert.equal(isWithinLiveHours({ tz: "UTC", days: [4], start: "oops", end: "17:00" }, new Date("2026-11-12T13:00:00Z")), false);
  assert.equal(isWithinLiveHours({ tz: "Not/AZone", days: [4], start: "09:00", end: "17:00" }, new Date("2026-11-12T13:00:00Z")), false);
});

test("normalizeSupportLiveHours validates shape and filters bad days", () => {
  assert.equal(normalizeSupportLiveHours(null), null);
  assert.equal(normalizeSupportLiveHours("nope"), null);
  assert.equal(normalizeSupportLiveHours({ tz: "UTC", start: "09:00", end: "17:00" }), null); // no days
  assert.equal(normalizeSupportLiveHours({ days: [1], start: "09:00", end: "17:00" }), null); // no tz
  const ok = normalizeSupportLiveHours({ tz: "UTC", days: [1, 2, 9, -1, 5], start: "09:00", end: "17:00" });
  assert.deepEqual(ok, { tz: "UTC", days: [1, 2, 5], start: "09:00", end: "17:00" });
});

test("isSoftwareModeWorkspace: managed home workspace is NOT software mode; others are", () => {
  assert.equal(isSoftwareModeWorkspace(MANAGED_SUPPORT_WORKSPACE_ID), false);
  assert.equal(isSoftwareModeWorkspace("11111111-2222-3333-4444-555555555555"), true);
});

test("softwareHandoffReply: honest, time-of-day-appropriate wording", () => {
  assert.match(softwareHandoffReply(true), /stay in this chat/i);
  assert.match(softwareHandoffReply(false), /email within one business day/i);
});
