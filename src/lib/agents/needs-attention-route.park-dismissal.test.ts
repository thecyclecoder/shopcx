/**
 * Unit tests for `parkDismissalSuppresses` — the Phase 2 owner-dismissal guard decision
 * (dismissing-a-park-card-closes-its-job).
 *
 * THE GAP THIS PINS. Even after Phase 1 settles a job on dismiss, a race (the settle lost to a
 * concurrent re-read) or a job re-parked by its OWN lane could let the backstop re-mint a card the
 * owner already dismissed. `ownerDismissedPark` looks up the newest dismissed `parkbackstop:<jobId>`
 * card and applies exactly this predicate: a dismissed park stays dismissed unless the job was
 * genuinely re-touched AFTER the dismissal.
 *
 * Run:  npx tsx --test src/lib/agents/needs-attention-route.park-dismissal.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parkDismissalSuppresses } from "./needs-attention-route";

const T0 = "2026-10-13T10:00:00.000Z";
const T1 = "2026-10-13T11:00:00.000Z"; // one hour later

test("no dismissed card → never suppress (nothing to stand on)", () => {
  assert.equal(parkDismissalSuppresses({ jobUpdatedAt: T0, dismissedCardAt: null }), false);
});

test("dismissed card, job NOT touched since (updated_at older) → suppress — the race case", () => {
  assert.equal(parkDismissalSuppresses({ jobUpdatedAt: T0, dismissedCardAt: T1 }), true);
});

test("dismissed card, job updated_at equals the card time → suppress (boundary is inclusive)", () => {
  assert.equal(parkDismissalSuppresses({ jobUpdatedAt: T1, dismissedCardAt: T1 }), true);
});

test("dismissed card, job RE-TOUCHED after the dismissal (updated_at newer) → re-surface", () => {
  // A genuine re-park by the job's own lane deserves a fresh card — the owner's dismissal was about
  // the PRIOR state.
  assert.equal(parkDismissalSuppresses({ jobUpdatedAt: T1, dismissedCardAt: T0 }), false);
});

test("dismissed card but job has no updated_at → suppress (no evidence of a change since)", () => {
  assert.equal(parkDismissalSuppresses({ jobUpdatedAt: null, dismissedCardAt: T0 }), true);
});
