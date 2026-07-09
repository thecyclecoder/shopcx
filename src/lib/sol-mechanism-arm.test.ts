/**
 * Unit tests for computeResumeStep — the step the box arms a playbook at after Sol's opening reply.
 * Run: npx tsx --test src/lib/sol-mechanism-arm.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeResumeStep, OPENING_PREFIX_STEP_TYPES } from "./sol-mechanism-arm";

test("refund playbook layout → resumes at step 4 (offer_exception), skipping identify/check/apply_policy", () => {
  const types = [
    "identify_order",
    "identify_subscription",
    "check_other_subscriptions",
    "apply_policy",
    "offer_exception",
    "initiate_return",
    "cancel_subscription",
    "stand_firm",
  ];
  assert.equal(computeResumeStep(types), 4);
});

test("a playbook that opens straight into apply_policy resumes at the next step", () => {
  assert.equal(computeResumeStep(["apply_policy", "offer_exception"]), 1);
});

test("no leading prefix (first step is an offer) → resume at 0 (nothing to skip)", () => {
  assert.equal(computeResumeStep(["offer_exception", "initiate_return"]), 0);
});

test("all steps are prefix (identify/apply_policy only) → resumeStep === length (caller leaves it un-armed)", () => {
  const types = ["identify_order", "apply_policy"];
  assert.equal(computeResumeStep(types), types.length);
});

test("a trailing stand_firm is NOT part of the leading prefix (contiguous from index 0 only)", () => {
  // The refund playbook's step 7 stand_firm must not pull the resume pointer past the offer steps.
  const types = ["apply_policy", "offer_exception", "stand_firm"];
  assert.equal(computeResumeStep(types), 1);
});

test("empty step list → 0", () => {
  assert.equal(computeResumeStep([]), 0);
});

test("OPENING_PREFIX_STEP_TYPES covers the identify/check/apply_policy family, not offer/return/cancel", () => {
  assert.ok(OPENING_PREFIX_STEP_TYPES.has("apply_policy"));
  assert.ok(OPENING_PREFIX_STEP_TYPES.has("identify_order"));
  assert.ok(!OPENING_PREFIX_STEP_TYPES.has("offer_exception"));
  assert.ok(!OPENING_PREFIX_STEP_TYPES.has("initiate_return"));
});
