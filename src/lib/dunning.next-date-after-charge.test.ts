import { test } from "node:test";
import assert from "node:assert/strict";
import { nextDateAfterCharge } from "@/lib/dunning";

const NOW = new Date("2026-10-08T12:00:00Z");

// ⭐ The bug this guards. An EARLY Order Now (due still in the future) used to roll forward from
// `due`, which is a no-op when `due` is in the future — so the date never moved and the sub was
// stranded on one date (ground truth 2026-10-08, Ashley Denson). An early press must ALWAYS advance
// by exactly one cadence.
test("early press (due in future) advances exactly one cadence", () => {
  const due = new Date("2026-10-25T08:00:00Z"); // 17 days out
  const out = nextDateAfterCharge(due, NOW, "month", 1);
  assert.equal(out.toISOString(), "2026-11-25T08:00:00.000Z");
  assert.ok(out.getTime() > due.getTime(), "must move past the original due date");
});

test("early press on a weekly cadence advances by the whole interval", () => {
  const due = new Date("2026-10-20T08:00:00Z");
  const out = nextDateAfterCharge(due, NOW, "week", 4);
  assert.equal(out.toISOString(), "2026-11-17T08:00:00.000Z"); // +28 days
});

// A LATE press (due already past) rolls forward past now — from max(due, now) = now.
test("late press (due in past) rolls forward past now", () => {
  const due = new Date("2026-09-01T08:00:00Z"); // over a month ago
  const out = nextDateAfterCharge(due, NOW, "month", 1);
  assert.ok(out.getTime() > NOW.getTime(), "must land in the future");
  // Anchored to now (max(due, now)), advanced one cadence.
  assert.equal(out.toISOString(), "2026-11-08T12:00:00.000Z");
});

test("a press exactly at the due moment still advances one cadence", () => {
  const due = new Date(NOW);
  const out = nextDateAfterCharge(due, NOW, "month", 1);
  assert.ok(out.getTime() > NOW.getTime(), "must not be a no-op at the boundary");
  assert.equal(out.toISOString(), "2026-11-08T12:00:00.000Z");
});
