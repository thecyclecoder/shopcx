/**
 * serialize-goal-member-spec-builds Phase 2 — the DIRTY-detect predicate.
 *
 * Pins the two named states from the spec verification:
 *   1) A goal-member PR whose base advanced (mergeable_state="behind" or "dirty") → re-drive.
 *   2) A PR whose GitHub state can't be read → left untouched (fail closed).
 *
 * Pure — no I/O. Run:
 *   npx tsx --test src/lib/goal-member-pr-redrive.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideGoalMemberPrRedrive } from "./agent-jobs";

test("dirty PR → re-drive (literal merge conflict)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "dirty" });
  assert.equal(r.action, "redrive");
  assert.match(r.reason, /dirty/);
});

test("behind PR → re-drive (base advanced, the 2026-07-06 goal-member case)", () => {
  // The named failing state from the spec verification: "A synthetic goal-member PR made DIRTY (base
  // advanced) is detected within one reconcile and a rebase/rebuild job enqueued."
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "behind" });
  assert.equal(r.action, "redrive");
  assert.match(r.reason, /behind/);
});

test("clean PR → skip (nothing to resolve)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "clean" });
  assert.equal(r.action, "skip");
});

test("unstable PR → skip (mergeable, just a red check — handled by the auto-merge gate)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "unstable" });
  assert.equal(r.action, "skip");
});

test("blocked PR → skip (waiting on a required check — not a re-drive case)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "blocked" });
  assert.equal(r.action, "skip");
});

test("read failed → skip (Phase 2 verification: fail closed)", () => {
  // "A PR whose GitHub state can't be read is left untouched (no false re-drive)"
  const r = decideGoalMemberPrRedrive({ ok: false });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /read failed|fail closed/i);
});

test("mergeable_state=null → skip (GitHub still computing — fail closed)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: null });
  assert.equal(r.action, "skip");
});

test("mergeable_state=\"unknown\" → skip (GitHub returned the uncertain enum)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "open", merged: false, mergeableState: "unknown" });
  assert.equal(r.action, "skip");
});

test("already-merged PR → skip (nothing to re-drive)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "closed", merged: true, mergeableState: "dirty" });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /already merged/i);
});

test("closed-not-merged PR → skip (only open PRs are re-drivable)", () => {
  const r = decideGoalMemberPrRedrive({ ok: true, state: "closed", merged: false, mergeableState: "dirty" });
  assert.equal(r.action, "skip");
  assert.match(r.reason, /only open/i);
});
