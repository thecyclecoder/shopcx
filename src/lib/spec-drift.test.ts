/**
 * spec-drift tests — the reverse-drift reconciler's REVERT decision for director-flipped suspects
 * ([[../specs/ada-director-spec-status-cards]] Phase 3). Pure-logic tests over the most-recent-first
 * spec_status_history rows so we can prove the reversibility backstop without a live Supabase.
 *
 * Run: npx tsx --test src/lib/spec-drift.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decideDirectorRevertFromRows } from "./spec-drift";

test("decideDirectorRevertFromRows reverts a director-stamped planned → shipped flip back to planned", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: '"planned"', to_value: '"shipped"' },
  ]);
  assert.deepEqual(decision, { revertTo: "planned", directorActor: "director:platform" });
});

test("decideDirectorRevertFromRows falls back to in_progress when the prior value is missing", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: null, to_value: '"shipped"' },
  ]);
  assert.deepEqual(decision, { revertTo: "in_progress", directorActor: "director:platform" });
});

test("decideDirectorRevertFromRows does NOT revert a merge-stamped shipped flip (build merge is trusted)", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "merge:abc1234", from_value: '"in_progress"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows does NOT revert when the most recent director flip targeted non-shipped", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "director:platform", from_value: '"planned"', to_value: '"in_progress"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows does NOT revert when an owner flip is the most recent status row", () => {
  const decision = decideDirectorRevertFromRows([
    { actor: "owner:00000000-0000-0000-0000-000000000000", from_value: '"in_progress"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});

test("decideDirectorRevertFromRows returns null on empty history", () => {
  assert.equal(decideDirectorRevertFromRows([]), null);
});

test("decideDirectorRevertFromRows ignores earlier director flips when the most recent row is a merge", () => {
  // Order is most-recent-first. The merge is trusted, even though a prior director flip exists.
  const decision = decideDirectorRevertFromRows([
    { actor: "merge:def5678", from_value: '"planned"', to_value: '"shipped"' },
    { actor: "director:platform", from_value: '"planned"', to_value: '"shipped"' },
  ]);
  assert.equal(decision, null);
});
