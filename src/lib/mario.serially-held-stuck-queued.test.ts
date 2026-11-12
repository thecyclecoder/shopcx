/**
 * Unit tests for the serializer legit-wait drop widened to the STUCK-QUEUED source —
 * mario-serializer-drop-covers-queued-goal-member-builds Phase 1. Pins the predicate
 * `shouldDropSeriallyHeldGoalMember` across both sources it now covers:
 *
 *   spec_authored (sixth / eligible-never-enqueued source): unchanged — ok:false ⇒ drop,
 *   ok:true ⇒ keep. liveJobStatus is irrelevant to this source.
 *
 *   job_queued (stuck-queued source, to_event==='job_claimed'): a goal member that ALREADY
 *   has a `queued` build job the goal dispatch serializer is actively holding. Drop ONLY when
 *   the serializer is refusing (ok:false) AND the live job is still `queued`; a non-`queued`
 *   live job (dead/partitioned worker) or ok:true (starved queue, one-off, admissible) is a
 *   real stall and must survive.
 *
 * Pure predicate — no I/O, no DB. Run:
 *   npx tsx --test src/lib/mario.serially-held-stuck-queued.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldDropSeriallyHeldGoalMember } from "./mario";

// ── spec_authored source (original behavior — must stay byte-identical) ──────────────────────

test("spec_authored + serializer refusing (ok:false) → DROP (legit serial wait)", () => {
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "spec_authored",
      dispatch: { ok: false, reason: "serialized to prevent hot-file collisions" },
    }),
    true,
  );
});

test("spec_authored + serializer admits (ok:true) → KEEP (real stall)", () => {
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "spec_authored",
      dispatch: { ok: true },
    }),
    false,
  );
});

// ── stuck-queued source (the new behavior this phase adds) ───────────────────────────────────

test("stuck-queued (job_queued) + serializer refusing + live job queued → DROP (serializer holding a queued build)", () => {
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "job_queued",
      dispatch: { ok: false, reason: "another goal-member build is in-flight" },
      liveJobStatus: "queued",
    }),
    true,
  );
});

test("stuck-queued (job_queued) + serializer admits (ok:true) → KEEP (genuinely starved queue / one-off / admissible member)", () => {
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "job_queued",
      dispatch: { ok: true },
      liveJobStatus: "queued",
    }),
    false,
  );
});

test("stuck-queued (job_queued) + serializer refusing but live job NOT queued → KEEP (dead/partitioned worker is a real stall)", () => {
  // The whole point of the liveJobStatus gate: a non-serializer stuck queue (e.g. the job was
  // claimed then the worker died, or no live job at all) must still surface as a real stall.
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "job_queued",
      dispatch: { ok: false, reason: "whatever" },
      liveJobStatus: "running",
    }),
    false,
  );
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "job_queued",
      dispatch: { ok: false, reason: "whatever" },
      liveJobStatus: null,
    }),
    false,
  );
});

// ── other sources are untouched ──────────────────────────────────────────────────────────────

test("unrelated source (build_started) → KEEP regardless of dispatch/liveJobStatus (those classes carry a real job to act on)", () => {
  assert.equal(
    shouldDropSeriallyHeldGoalMember({
      fromEvent: "build_started",
      dispatch: { ok: false, reason: "whatever" },
      liveJobStatus: "queued",
    }),
    false,
  );
});
