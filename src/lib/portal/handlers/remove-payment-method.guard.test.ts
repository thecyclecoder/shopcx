/**
 * Pins the last-card renewal-safety decision the portal removal handler
 * enforces. Extracted as a pure predicate so the rule can be tested
 * without mocking Supabase — same shape `pickChargeableVaultedPm` uses
 * in `src/lib/action-executor.vaulted-pm-guard.test.ts`.
 *
 * The FAILING STATE these tests pin: prior to Phase 1, the handler only
 * blocked removal when a subscription EXPLICITLY pinned the card via
 * `subscriptions.payment_method_id`. But the renewal charge path in
 * `src/lib/inngest/internal-subscription-renewals.ts:694-722` falls
 * back to the link group's `is_default` active card when the sub itself
 * pins nothing, so a customer whose only card was unpinned could delete
 * it and silently break every renewal in the group. This predicate
 * captures the added rule.
 *
 * Run: `npx tsx --test src/lib/portal/handlers/remove-payment-method.guard.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { shouldBlockLastCardRemoval } from "./remove-payment-method";

test("blocks when no replacement AND at least one internal sub is active/paused (the pinned-guard gap)", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: null, activeInternalSubCount: 1 }),
    true,
  );
});

test("blocks when no replacement AND many internal subs are active/paused", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: null, activeInternalSubCount: 7 }),
    true,
  );
});

test("allows when a replacement card exists — the sub can still charge after promotion", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: "pm-other", activeInternalSubCount: 1 }),
    false,
  );
});

test("allows when a replacement exists even if many internal subs are active/paused", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: "pm-other", activeInternalSubCount: 12 }),
    false,
  );
});

test("allows when no internal sub is active/paused — nothing to break", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: null, activeInternalSubCount: 0 }),
    false,
  );
});

test("allows when neither a replacement nor an internal sub exists (external-only customer)", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: null, activeInternalSubCount: 0 }),
    false,
  );
});

test("allows when a replacement exists and no internal sub is active/paused", () => {
  assert.equal(
    shouldBlockLastCardRemoval({ replacementCardId: "pm-other", activeInternalSubCount: 0 }),
    false,
  );
});
