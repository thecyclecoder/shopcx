/**
 * Regression test for `selectNextUnbuiltPlannedPhase` — the pure ordered-scan helper behind
 * [[queueNextChainedPhase]] added by unstamped-phase-cannot-silently-strand-a-build Phase 2.
 *
 * THE WEDGE THIS PINS. Even after the 2026-08-11 fix that made `nextPhaseToBuild` skip a phase
 * whose `build_sha` is set, one wedge remained: a phase whose build ran to completion but
 * `stampPhaseBuilt` never landed reads `planned` + `build_sha=null`, and its scoped build job
 * exists on `agent_jobs`. The OLD `queueNextChainedPhase` did a single `find(status ===
 * 'planned')`, then the DEDUP query at line 3600-3608 saw the matching build job and returned
 * null — every LATER phase (notably an appended fix phase from a security or spec-test gate)
 * became permanently unreachable.
 *
 * Verified live on the card-removal spec: its 2026-08-16 20:38 build job carried
 * `phaseScopedInstructions('P1 — implement the fix')` byte-for-byte while P1's `build_sha` was
 * null; the appended fix phase at position 2 was never considered, and the PR sat 17 hours with
 * a real credential leak. The helper turns the single-find into an ordered scan so a missed
 * stamp costs a skipped phase, not the whole spec.
 *
 * Pure — no live DB. Same shape `pickChargeableVaultedPm` uses in
 * `action-executor.vaulted-pm-guard.test.ts`.
 *
 * Run: `npx tsx --test src/lib/agent-jobs.chain-advance-skip.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { phaseScopedInstructions, selectNextUnbuiltPlannedPhase } from "./agent-jobs";

// ── (1) THE WEDGE — an already-built P1 lets a later, un-built fix phase be picked ─────

test("THE WEDGE (card-removal): first planned phase already has a build job → helper skips it and picks the later planned phase", () => {
  const titles = ["P1 — implement the fix", "Fix 1 — resolve 1 pre-merge security finding"];
  const existing = new Set<string>([
    phaseScopedInstructions("P1 — implement the fix"), // the missed-stamp build job
  ]);
  const next = selectNextUnbuiltPlannedPhase(titles, existing);
  assert.equal(next, "Fix 1 — resolve 1 pre-merge security finding");
});

test("THE WEDGE (multi-skip): the first TWO planned phases each have a matching build job → picks the third", () => {
  const titles = ["P1", "P2", "P3"];
  const existing = new Set<string>([
    phaseScopedInstructions("P1"),
    phaseScopedInstructions("P2"),
  ]);
  assert.equal(selectNextUnbuiltPlannedPhase(titles, existing), "P3");
});

// ── (2) UNCHANGED BEHAVIOUR — no matching build job → picks the first ─────────────────

test("UNCHANGED: no planned phase carries a matching build job → picks the FIRST one, in order", () => {
  const titles = ["P1", "P2", "P3"];
  const existing = new Set<string>();
  assert.equal(selectNextUnbuiltPlannedPhase(titles, existing), "P1");
});

test("UNCHANGED: unrelated build-job instructions in the set → picks the first planned title", () => {
  // Someone hand-queued an ad-hoc build with a different instruction body — it must NOT be
  // mistaken for a scoped-phase build (the helper hashes against phaseScopedInstructions only).
  const titles = ["P1", "P2"];
  const existing = new Set<string>([
    "Rebuild the whole spec.",
    "Do a fresh pass on all phases.",
    phaseScopedInstructions("A completely different phase that is not on this spec"),
  ]);
  assert.equal(selectNextUnbuiltPlannedPhase(titles, existing), "P1");
});

// ── (3) CHAIN COMPLETE — every planned phase already has one → null ───────────────────

test("CHAIN COMPLETE: every planned phase already has a matching build job → returns null", () => {
  const titles = ["P1", "P2"];
  const existing = new Set<string>([
    phaseScopedInstructions("P1"),
    phaseScopedInstructions("P2"),
  ]);
  assert.equal(selectNextUnbuiltPlannedPhase(titles, existing), null);
});

test("CHAIN COMPLETE: empty title list (no planned phases left) → returns null (no throw)", () => {
  assert.equal(selectNextUnbuiltPlannedPhase([], new Set<string>()), null);
});

// ── Selection stability — the ORDER of the title list is honored ──────────────────────

test("ORDER: the helper walks the caller's list in order, not sorted / not lexicographic", () => {
  // Caller filtered to `status === "planned" && !build_sha` and mapped to titles in spec-phase order.
  // The helper must NOT reorder them — position order is the invariant.
  const titles = ["P3 — the third", "P1 — the first", "P2 — the second"];
  const existing = new Set<string>([phaseScopedInstructions("P3 — the third")]);
  // Skips P3 (has a build job), returns the next in the caller's order → P1, not "the first" lexicographically.
  assert.equal(selectNextUnbuiltPlannedPhase(titles, existing), "P1 — the first");
});
