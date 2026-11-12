/**
 * Unit tests for the serially-held goal-member legit-wait drop — spec
 * "serial-held-goal-member-legit-wait-drop-must-also-cover-the-stuck-queued-build-source" Phase 1.
 *
 * `shouldDropSeriallyHeldGoalMember` is the pure predicate the (d3) source-level drop consults:
 * when the goal build-dispatch serializer is legitimately holding a member build (dispatch
 * ok:false), the candidate is a legit serial wait, not a stall, and is dropped BEFORE surfacing to
 * the M4 agent (no mario_fired row, no oscillation-guard pressure, no wasted Max session).
 *
 * The drop originally fired only for the SIXTH source (`from_event === "spec_authored"`,
 * eligible-never-enqueued). This phase extends it to the SEVENTH source (`from_event ===
 * "build_queued"`, stuck-queued), which the pre-launch serial-claim serializer produces by claiming
 * then RELEASING a member build back to `queued` while a sibling member builds — the identical legit
 * serial wait. Both sources now sit in SERIAL_HELD_SOURCE_FROM_EVENTS.
 *
 * Run:
 *   npx tsx --test src/lib/mario.serially-held-source.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldDropSeriallyHeldGoalMember } from "./mario";

const HELD = { ok: false as const, reason: "conflicting goal-mate build in flight" };
const ADMISSIBLE = { ok: true as const };

test("spec_authored + ok:false (serializer holding) → DROP", () => {
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "spec_authored", dispatch: HELD }), true);
});

test("spec_authored + ok:true (admissible / one-off) → KEEP", () => {
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "spec_authored", dispatch: ADMISSIBLE }), false);
});

test("build_queued + ok:false (serial-claim released, sibling building) → DROP", () => {
  // The seventh source's new coverage: a stuck-queued member whose build was claimed then released
  // back to `queued` by the serializer is a legit serial wait, not a stall.
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "build_queued", dispatch: HELD }), true);
});

test("build_queued + ok:true (admissible member) → KEEP", () => {
  // A genuinely stuck queued build the serializer would ADMIT survives to the M4 agent — a real stall.
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "build_queued", dispatch: ADMISSIBLE }), false);
});

test("other source (failed_build) + ok:false → KEEP (untouched by this filter)", () => {
  // Sources outside SERIAL_HELD_SOURCE_FROM_EVENTS carry a real job/PR to act on; the serial-build
  // gate does not apply and the candidate is never dropped by this predicate.
  assert.equal(shouldDropSeriallyHeldGoalMember({ fromEvent: "failed_build", dispatch: HELD }), false);
});
