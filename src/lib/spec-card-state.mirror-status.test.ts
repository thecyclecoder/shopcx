/**
 * Named failing state: `markSpecCardForReview` / `markSpecCardBackToReview` patched the mirror with
 * `status: 'in_review'`, which `spec_card_state_status_check` (planned | in_progress | shipped |
 * rejected) rejects — so Postgres threw out the ENTIRE upsert, taking the flags in the same patch
 * with it. supabase-js returns `{error}` instead of throwing, and the writer swallowed it, so this
 * was invisible: 242 recorded `→ in_review` transitions over 14 days (~17/day) and ZERO
 * `spec_card_state` rows have ever held `in_review`.
 *
 * The cost was not the status (which nothing reads — `deriveSpecCardStatus` is pinned to never emit
 * `in_review`, see brain-roadmap.derive-status-no-in-review.test.ts). It was the flag clearing that
 * rode along in the same patch — above all `ada_disposition`, which is what makes Ada re-disposition
 * a spec the CEO sent back for review.
 *
 * Pure helpers — no I/O, no DB. Run:
 *   npx tsx --test src/lib/spec-card-state.mirror-status.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MIRROR_STATUSES, isMirrorStatus } from "@/lib/spec-card-state";

test("MIRROR_STATUSES matches the live spec_card_state_status_check exactly", () => {
  assert.deepEqual([...MIRROR_STATUSES].sort(), ["in_progress", "planned", "rejected", "shipped"]);
});

for (const ok of ["planned", "in_progress", "shipped", "rejected"]) {
  test(`'${ok}' is accepted by the mirror`, () => {
    assert.equal(isMirrorStatus(ok), true);
  });
}

test("'in_review' is REJECTED — it is derived, and the review state lives in flags", () => {
  assert.equal(isMirrorStatus("in_review"), false);
});

// `deferred` / `folded` are first-class lifecycle states on public.specs, but the mirror's own
// constraint has never accepted them either — `deferred` rides on flags.deferred. Pin that so a
// future caller doesn't reintroduce the same whole-patch-abort by a different door.
for (const bad of ["deferred", "folded", "", "PLANNED", "in review"]) {
  test(`'${bad}' is rejected by the mirror`, () => {
    assert.equal(isMirrorStatus(bad), false);
  });
}
