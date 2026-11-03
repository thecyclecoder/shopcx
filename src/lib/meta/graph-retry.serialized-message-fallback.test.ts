/**
 * Regression tests for [[graph-retry]] human-blocked containment surviving the
 * INNGEST STEP BOUNDARY —
 * [[../../../docs/brain/specs/meta-human-blocked-class-survive-inngest-step-serialization]]
 * Phase 1.
 *
 * The incident: the containment built for the 2026-08-02 invalidated-token
 * incident is silently defeated whenever a Meta GraphError is raised INSIDE an
 * Inngest step. Inngest only preserves name/message/stack/code/cause across a
 * step-retry boundary, so by the time the function catch runs the error has
 * been rehydrated as a plain Error and the `metaClass` tag the human-blocked
 * predicates read is GONE — the run fails and Platform is paged every single
 * day for a condition the system was designed to contain quietly.
 *
 * The one signal that survives is the canonical `meta_<status>: <detail>`
 * message built by [[graphError]]. This file pins that the human-blocked
 * predicates re-derive the class from that surviving message when `metaClass`
 * is absent, while the authoritative tagged path is unchanged and unrelated
 * meta_400 validation errors are NOT swept up.
 *
 * Run:
 *   npx tsx --test src/lib/meta/graph-retry.serialized-message-fallback.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isReconnectRequiredError,
  isAppOwnerActionRequiredError,
  isHumanBlockedGraphError,
  reconnectRequiredFromSerializedMessage,
  appOwnerActionRequiredFromSerializedMessage,
  graphError,
} from "./graph-retry";

// ── the exact Inngest-serialization failure boundary ────────────────────────

test("isReconnectRequiredError — a metaClass-less rehydrated meta_400 invalidated-token error is still contained", () => {
  // This is EXACTLY what the function-level catch sees after Inngest rehydrates
  // a step throw: a plain Error with the message but no metaClass tag.
  const rehydrated = new Error(
    "meta_400: Error validating access token: Session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.",
  );
  assert.equal((rehydrated as { metaClass?: string }).metaClass, undefined);
  assert.equal(reconnectRequiredFromSerializedMessage(rehydrated), true);
  assert.equal(isReconnectRequiredError(rehydrated), true);
  assert.equal(isHumanBlockedGraphError(rehydrated), true);
});

test("isReconnectRequiredError — a metaClass-less 'meta_400: API access blocked.' is still contained", () => {
  const rehydrated = new Error("meta_400: API access blocked.");
  assert.equal(isReconnectRequiredError(rehydrated), true);
  assert.equal(isHumanBlockedGraphError(rehydrated), true);
});

test("isAppOwnerActionRequiredError — a metaClass-less 'meta_400: … Data Use Checkup …' is still contained", () => {
  const rehydrated = new Error(
    "meta_400: Your app must complete the Data Use Checkup to continue accessing this API.",
  );
  assert.equal((rehydrated as { metaClass?: string }).metaClass, undefined);
  assert.equal(appOwnerActionRequiredFromSerializedMessage(rehydrated), true);
  assert.equal(isAppOwnerActionRequiredError(rehydrated), true);
  assert.equal(isHumanBlockedGraphError(rehydrated), true);
});

// ── the authoritative in-memory tagged path is UNCHANGED ─────────────────────

test("isReconnectRequiredError — an in-memory tagged error (metaClass set) still passes", () => {
  const tagged = graphError(400, { code: 190, message: "Error validating access token" });
  assert.equal(tagged.metaClass, "reconnect_required");
  assert.equal(isReconnectRequiredError(tagged), true);
});

test("isAppOwnerActionRequiredError — an in-memory tagged error (metaClass set) still passes", () => {
  const tagged = graphError(400, {
    message: "Your app must complete the Data Use Checkup to continue.",
  });
  assert.equal(tagged.metaClass, "app_owner_action_required");
  assert.equal(isAppOwnerActionRequiredError(tagged), true);
});

// ── unrelated / malformed messages are NOT swept up ──────────────────────────

test("reconnectRequiredFromSerializedMessage — an unrelated meta_400 param-validation error does NOT classify", () => {
  const rehydrated = new Error("meta_400: Invalid parameter");
  assert.equal(reconnectRequiredFromSerializedMessage(rehydrated), false);
  assert.equal(isReconnectRequiredError(rehydrated), false);
  assert.equal(isHumanBlockedGraphError(rehydrated), false);
});

test("reconnectRequiredFromSerializedMessage — a meta_503 transient wobble message does NOT classify (non-400)", () => {
  // The status is re-extracted from the message, so a 5xx wobble that happens to
  // mention a token phrase must NOT be contained as a human-blocked error.
  const rehydrated = new Error("meta_503: Error validating access token (service unavailable)");
  assert.equal(reconnectRequiredFromSerializedMessage(rehydrated), false);
  assert.equal(isReconnectRequiredError(rehydrated), false);
});

test("reconnectRequiredFromSerializedMessage — a message without the meta_<status> prefix does NOT classify", () => {
  const rehydrated = new Error("Error validating access token: session has been invalidated");
  assert.equal(reconnectRequiredFromSerializedMessage(rehydrated), false);
});

test("reconnectRequiredFromSerializedMessage — a non-error / messageless value does NOT throw and returns false", () => {
  assert.equal(reconnectRequiredFromSerializedMessage(null), false);
  assert.equal(reconnectRequiredFromSerializedMessage(undefined), false);
  assert.equal(reconnectRequiredFromSerializedMessage({}), false);
  assert.equal(reconnectRequiredFromSerializedMessage("meta_400: whatever"), false);
});
