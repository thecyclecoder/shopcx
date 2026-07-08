/**
 * goal-member-builds-gate-at-enqueue-not-at-claim Phase 1 — enqueue-time admission predicate.
 *
 * Pins the NAMED failing state from the spec's Verification: attempt to enqueue builds for two
 * members of the same goal back to back → exactly ONE build agent_jobs row exists for that goal
 * afterward, and the second enqueue returns a "serialized, not admitted" result (no row inserted).
 *
 * The pure predicate is the seam this test exercises directly — it takes the set of ALREADY-INFLIGHT
 * goal-mate build rows and answers "may this enqueue proceed?". The wrapper reader
 * `evaluateGoalMemberEnqueueAdmission` does the DB work above it (resolve goal → list members →
 * .in on agent_jobs status ∈ ACTIVE_STATUSES). The gate is the DIFFERENCE from the claim-time
 * serializer's (b) leg — it fires BEFORE the row lands, so the CEO's board never carries two
 * queued goal-mates for the same goal.
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-enqueue-admission.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideGoalMemberEnqueueAdmission,
  type GoalMemberInflightRow,
} from "./agent-jobs";

test("no goal-mate in-flight: admitted", () => {
  const r = decideGoalMemberEnqueueAdmission({
    slug: "a-spec",
    goalSlug: "some-goal",
    inflight: [],
  });
  assert.deepEqual(r, { ok: true });
});

test("second back-to-back enqueue is refused while first is `queued`", () => {
  // The named failing state. Order-of-events: first enqueueBuildIfDue for a-spec inserts a
  // `queued` row; then the second call for b-spec runs. b-spec's admission reader sees a-spec
  // sitting `queued` and returns not-admitted — the second row is never inserted.
  const r = decideGoalMemberEnqueueAdmission({
    slug: "b-spec",
    goalSlug: "some-goal",
    inflight: [{ slug: "a-spec", status: "queued" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /serialized-goal-mate-in-flight/);
    assert.match(r.reason, /a-spec/);
    assert.match(r.reason, /some-goal/);
  }
});

test("goal-mate in `claimed`/`building`/other active states also refuses admission", () => {
  for (const status of ["claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage"]) {
    const r = decideGoalMemberEnqueueAdmission({
      slug: "b-spec",
      goalSlug: "g",
      inflight: [{ slug: "a-spec", status }],
    });
    assert.equal(r.ok, false, `status=${status} must refuse`);
  }
});

test("a self-row in the inflight list does not block the enqueue for the same slug", () => {
  // Defense-in-depth mirror of the reader's `.neq('spec_slug', slug)` filter: even if the pure
  // predicate is fed a self-row (a stale read landed the same row through), it MUST NOT
  // false-positive-refuse — otherwise a legitimate re-enqueue for THIS spec dead-ends.
  const r = decideGoalMemberEnqueueAdmission({
    slug: "a-spec",
    goalSlug: "g",
    inflight: [{ slug: "a-spec", status: "queued" }],
  });
  assert.deepEqual(r, { ok: true });
});

test("reason names the sibling slug + status so the enqueue log stays legible", () => {
  const r = decideGoalMemberEnqueueAdmission({
    slug: "c-spec",
    goalSlug: "guaranteed-ticket-handling",
    inflight: [{ slug: "a-spec", status: "building" }],
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /a-spec/);
    assert.match(r.reason, /building/);
    assert.match(r.reason, /guaranteed-ticket-handling/);
  }
});
