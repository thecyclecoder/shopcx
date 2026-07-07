/**
 * Unit tests for the check_vaulted_pm playbook step's pure decider —
 * docs/brain/specs/assisted-purchase-playbook.md Phase 2. Pins the four
 * transitions the spec's verification names:
 *
 *   (1) customer WITH a chargeable vaulted PM → advance to the terminal
 *       create step (skips add_payment_method entirely).
 *   (2) customer with NO PM AND not parked → launch add_payment_method
 *       + park.
 *   (3) parked; journey still open → wait (no re-launch, no message).
 *   (4) parked; journey completed but customer left no PM → resume with
 *       the "still missing" branch (clear parked flag; do NOT re-launch
 *       under this state machine — the outer handler chooses).
 *
 * The decider is a pure function of (rows, parked, journey) — no DB, no
 * mocks needed. Steps are DB rows (verified by the migration seeding
 * check_vaulted_pm + create_order / create_subscription rows); the pure
 * decider guarantees the RUNTIME semantics are also stable.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.check-vaulted-pm.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideCheckVaultedPmStep } from "./playbook-executor";

// ── (1) advance — has vaulted PM ──────────────────────────────────────

test("has chargeable vaulted PM → advance (skip add_payment_method entirely)", () => {
  const decision = decideCheckVaultedPmStep({
    rows: [{ id: "pm-1", status: "active", is_default: true }],
    parked: false,
    journey: null,
  });
  assert.equal(decision.kind, "advance");
  if (decision.kind === "advance") {
    assert.equal(decision.vaultedPmId, "pm-1");
  }
});

test("has vaulted PM AND was previously parked → still advance (post-journey resume)", () => {
  // The customer added a PM via the journey; the parked flag is stale
  // in ctx but the DB now shows an active row. The decider MUST prefer
  // the DB fact over the ctx flag — a stale parked flag can't gate a
  // customer who already has a chargeable PM.
  const decision = decideCheckVaultedPmStep({
    rows: [{ id: "pm-new", status: "active", is_default: true }],
    parked: true,
    journey: { status: "completed", outcome: "vaulted" },
  });
  assert.equal(decision.kind, "advance");
});

test("non-default active PM is chargeable → advance (returns the active row)", () => {
  const decision = decideCheckVaultedPmStep({
    rows: [{ id: "pm-only", status: "active", is_default: false }],
    parked: false,
    journey: null,
  });
  assert.equal(decision.kind, "advance");
  if (decision.kind === "advance") assert.equal(decision.vaultedPmId, "pm-only");
});

// ── (2) launch — no PM, not parked ────────────────────────────────────

test("no PM, not parked → launch (spec Verification bullet 2: launch + park)", () => {
  const decision = decideCheckVaultedPmStep({
    rows: [],
    parked: false,
    journey: null,
  });
  assert.equal(decision.kind, "launch");
});

test("only revoked/removed rows (no chargeable), not parked → launch", () => {
  const decision = decideCheckVaultedPmStep({
    rows: [
      { id: "pm-old", status: "revoked", is_default: true },
      { id: "pm-2", status: "removed", is_default: false },
    ],
    parked: false,
    journey: null,
  });
  assert.equal(decision.kind, "launch");
});

test("no rows at all (null), not parked → launch", () => {
  const decision = decideCheckVaultedPmStep({
    rows: null,
    parked: false,
    journey: null,
  });
  assert.equal(decision.kind, "launch");
});

// ── (3) wait — parked, journey still open ─────────────────────────────

test("parked; journey in progress (status='active') → wait (no re-launch)", () => {
  const decision = decideCheckVaultedPmStep({
    rows: [],
    parked: true,
    journey: { status: "active", outcome: null },
  });
  assert.equal(decision.kind, "wait");
});

test("parked; no journey row yet visible → wait", () => {
  // Race: launchJourneyForTicket wrote the session row but our read
  // hasn't seen it yet. The decider MUST wait, not re-launch.
  const decision = decideCheckVaultedPmStep({
    rows: [],
    parked: true,
    journey: null,
  });
  assert.equal(decision.kind, "wait");
});

// ── (4) resume_still_missing — parked, completed, no PM ───────────────

test("parked; journey completed but no PM → resume_still_missing (customer left the flow)", () => {
  // The failing state the spec's Verification bullet 2 implies at its
  // tail: after journey completion, the customer either (a) added a PM
  // and we skip to advance, OR (b) closed the mini-site without adding
  // one, in which case the decider surfaces the "still missing" branch
  // for a human/orchestrator to route.
  const decision = decideCheckVaultedPmStep({
    rows: [],
    parked: true,
    journey: { status: "completed", outcome: "abandoned" },
  });
  assert.equal(decision.kind, "resume_still_missing");
});

test("parked; journey completed AND rows exist but ALL revoked → resume_still_missing (no chargeable row)", () => {
  // Edge case: the customer added a card and then Braintree revoked it
  // before the playbook resumed (rare, but the state machine has to
  // treat 'no chargeable row' the same regardless of row count).
  const decision = decideCheckVaultedPmStep({
    rows: [{ id: "pm-x", status: "revoked", is_default: true }],
    parked: true,
    journey: { status: "completed", outcome: "vaulted" },
  });
  assert.equal(decision.kind, "resume_still_missing");
});
