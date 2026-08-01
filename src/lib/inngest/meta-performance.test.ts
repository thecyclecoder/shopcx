/**
 * Unit tests for isAppOwnerActionRequiredError — the predicate that decides
 * whether the metaIterationRun catch block treats a caught error as the Meta
 * App Dashboard human-blocked class (Data Use Checkup) or a regular failure
 * that must still rethrow through /api/inngest.
 *
 * The predicate pins the exact tag the escalation SDK stamps on the thrown
 * GraphError, so a future refactor of the catch block can't silently regress
 * Data Use Checkup back into a per-run /api/inngest crash while still keeping
 * every other Meta 400 / real regression loud on the Inngest failure feed.
 *
 * Run: npx tsx --test src/lib/inngest/meta-performance.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAppOwnerActionRequiredError } from "./meta-performance-app-owner-action";

test("isAppOwnerActionRequiredError — TAGGED tagged Data Use Checkup class is HANDLED", () => {
  // Canonical production shape: a GraphError raised by graphFetchJson after
  // classifyAppOwnerActionRequired flagged the response. The catch block sees
  // this as human-blocked → finishRun+return, NO notifyOpsAlert, NO rethrow.
  const err = Object.assign(new Error("(#200) Application does not have permission to access this resource"), {
    metaClass: "app_owner_action_required",
    status: 400,
  });
  assert.equal(isAppOwnerActionRequiredError(err), true);
});

test("isAppOwnerActionRequiredError — CONTROL: a regular Meta 500 rethrows (predicate false)", () => {
  // A real Meta outage keeps the existing rethrow branch: finishRun 'failed' +
  // notifyOpsAlert + rethrow so Inngest's failure feed surfaces the outage.
  const err = new Error("graph 500 — internal server error");
  assert.equal(isAppOwnerActionRequiredError(err), false);
});

test("isAppOwnerActionRequiredError — CONTROL: a different metaClass (permanent, non-owner) rethrows", () => {
  // Only the app_owner_action_required class is human-blocked; other tagged
  // GraphErrors (e.g. permanent authorization failures on a token) still need
  // the rethrow path so the ops alert fires.
  const err = Object.assign(new Error("permanent auth"), { metaClass: "permanent_authorization_failure" });
  assert.equal(isAppOwnerActionRequiredError(err), false);
});

test("isAppOwnerActionRequiredError — CONTROL: null / undefined / string errors rethrow", () => {
  // Defensive: the catch block is `catch (err)` (typed unknown) and TypeScript
  // guarantees nothing about the shape. A predicate that crashed on a
  // primitive would itself mask the underlying throw — verify each shape falls
  // through cleanly to `false` (rethrow branch).
  assert.equal(isAppOwnerActionRequiredError(null), false);
  assert.equal(isAppOwnerActionRequiredError(undefined), false);
  assert.equal(isAppOwnerActionRequiredError("some string error"), false);
  assert.equal(isAppOwnerActionRequiredError({}), false);
});
