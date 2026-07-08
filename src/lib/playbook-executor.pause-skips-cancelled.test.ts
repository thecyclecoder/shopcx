/**
 * Refund-playbook pause-step decider — pins the failing state named in
 * docs/brain/specs/refund-playbook-skips-pause-step-when-subscription-already-cancelled.md
 * Phase 1. A pause step run against an already-cancelled subscription
 * MUST skip (advance, no action, no claim); an active sub MUST still
 * pause. Ticket 472310cc — the unbacked-pause claim on a cancelled sub
 * previously hit the playbook-step claim-guard and dead-ended in
 * escalation.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.pause-skips-cancelled.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decidePauseSubscriptionStep } from "./playbook-executor";

test("already-cancelled sub → advance (skip pause, no action, no claim)", () => {
  const d = decidePauseSubscriptionStep(
    [{ shopify_contract_id: "SC1", status: "cancelled" }],
    "SC1",
    3,
  );
  assert.equal(d.action, "advance");
  if (d.action === "advance") {
    assert.equal(d.newStep, 4);
    assert.match(d.reason, /already cancelled/);
  }
});

test("active sub → pause (still fires when sub is actually active)", () => {
  const d = decidePauseSubscriptionStep(
    [{ shopify_contract_id: "SC1", status: "active" }],
    "SC1",
    3,
  );
  assert.equal(d.action, "pause");
  if (d.action === "pause") {
    assert.equal(d.contractId, "SC1");
  }
});

test("paused sub → pause (idempotent; only cancelled skips)", () => {
  const d = decidePauseSubscriptionStep(
    [{ shopify_contract_id: "SC1", status: "paused" }],
    "SC1",
    3,
  );
  assert.equal(d.action, "pause");
});

test("no identified subscription → advance", () => {
  const d = decidePauseSubscriptionStep(
    [{ shopify_contract_id: "SC1", status: "active" }],
    undefined,
    3,
  );
  assert.equal(d.action, "advance");
});

test("identified contract missing from subs → advance", () => {
  const d = decidePauseSubscriptionStep(
    [{ shopify_contract_id: "SC1", status: "active" }],
    "SC_MISSING",
    3,
  );
  assert.equal(d.action, "advance");
});
