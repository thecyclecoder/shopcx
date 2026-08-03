/**
 * Regression tests for [[graph-retry]] reconnect_required classification —
 * [[../../../docs/brain/specs/meta-reconnect-required-class]] Phase 1.
 *
 * The incident: after the CEO completed Meta's Data Use Checkup on 2026-08-02,
 * Meta switched to a second, undocumented phrasing — HTTP 400
 * `"API access blocked."` — on every call made with the stored USER token,
 * while the APP token (`{app_id}|{secret}`) still returned 200. That state
 * is NOT an app-owner gate (nothing left to do in the App Dashboard); the
 * stored user token had been invalidated by the lapsed checkup and only
 * OAuth re-consent restored access. Misclassifying it as
 * `app_owner_action_required` would raise the WRONG card, pointing the
 * founder at the App Dashboard while spend continued unmeasured.
 *
 * Ordering is load-bearing in [[graphError]]: `classifyAppOwnerActionRequired`
 * runs FIRST so a Data Use Checkup 400 can never be downgraded to a reconnect
 * prompt; `classifyReconnectRequired` runs SECOND; `isPermanentGraphError`
 * runs THIRD. This file pins both classifications and the ordering.
 *
 * Run:
 *   npx tsx --test src/lib/meta/graph-retry.reconnect-required.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAppOwnerActionRequired,
  classifyReconnectRequired,
  graphError,
  isPermanentGraphError,
  isTransientGraphError,
} from "./graph-retry";

// ── classifyReconnectRequired — the classifier ──────────────────────────────

test("classifyReconnectRequired — 'API access blocked.' HTTP 400 message classifies true", () => {
  assert.equal(
    classifyReconnectRequired(400, {
      message: "API access blocked.",
    }),
    true,
  );
});

test("classifyReconnectRequired — 'API access blocked' inside error_user_msg classifies true (case-insensitive)", () => {
  assert.equal(
    classifyReconnectRequired(400, {
      error_user_msg: "Your access token was invalidated. API access blocked until you reconnect.",
    }),
    true,
  );
});

test("classifyReconnectRequired — 'API access blocked' inside error_user_title classifies true", () => {
  assert.equal(
    classifyReconnectRequired(400, {
      error_user_title: "API access blocked",
      error_user_msg: "Please reconnect the Meta integration.",
    }),
    true,
  );
});

test("classifyReconnectRequired — a Data Use Checkup 400 does NOT classify (belongs to app_owner_action_required)", () => {
  // Ordering-regression guard: the Data Use Checkup phrasing is claimed by
  // classifyAppOwnerActionRequired FIRST in graphError so a workspace-owner
  // action can never be downgraded to a reconnect prompt.
  assert.equal(
    classifyReconnectRequired(400, {
      message: "Your app must complete the Data Use Checkup to continue accessing this API.",
    }),
    false,
  );
});

test("classifyReconnectRequired — non-400 status does NOT classify (5xx wobble is transient)", () => {
  assert.equal(
    classifyReconnectRequired(503, {
      message: "API access blocked",
    }),
    false,
  );
});

test("classifyReconnectRequired — an unrelated 400 (invalid token, code 190) does NOT classify", () => {
  assert.equal(
    classifyReconnectRequired(400, {
      code: 190,
      message: "Invalid access token",
    }),
    false,
  );
});

// ── mutual-exclusion with the other three classes ────────────────────────────

test("'API access blocked' 400 — reconnect_required AND NOT app_owner AND NOT permanent AND NOT transient", () => {
  const err = { message: "API access blocked." };
  assert.equal(classifyReconnectRequired(400, err), true);
  assert.equal(classifyAppOwnerActionRequired(400, err), false);
  assert.equal(isPermanentGraphError(400, err), false);
  assert.equal(isTransientGraphError(400, err), false);
});

// ── graphError tags metaClass on classification (ordering is load-bearing) ──

test("graphError — 'API access blocked' 400 tags metaClass='reconnect_required'", () => {
  const err = graphError(400, {
    message: "API access blocked.",
  });
  assert.equal(err.metaClass, "reconnect_required");
  assert.equal(err.httpStatus, 400);
});

test("graphError — a Data Use Checkup 400 still tags metaClass='app_owner_action_required' (ordering regression guard)", () => {
  // If the ordering were reversed, a Data Use Checkup 400 that ALSO happened
  // to contain the phrase 'api access blocked' would misroute to a reconnect
  // card. Pin the current order.
  const err = graphError(400, {
    message: "Your app must complete the Data Use Checkup to continue accessing this API.",
  });
  assert.equal(err.metaClass, "app_owner_action_required");
});

test("graphError — a message tripping BOTH classifiers tags as app_owner_action_required (checked first)", () => {
  // A pathological Meta message that contains both phrases must resolve to
  // the App Dashboard action, not the reconnect prompt — the workspace owner
  // is a human who can only be pointed at one remedy at a time, and the
  // Data Use Checkup is the SUPERSET remedy (clearing it also refreshes the
  // token). Same deterministic-ordering rule as the app_owner-vs-permanent
  // pairing that already exists.
  const err = graphError(400, {
    message: "Data Use Checkup required — API access blocked until you complete it.",
  });
  assert.equal(err.metaClass, "app_owner_action_required");
});

test("graphError — a plain fatal 400 (invalid token) does NOT tag metaClass (falls through to ordinary fatal)", () => {
  const err = graphError(400, {
    code: 190,
    message: "Invalid OAuth access token.",
  });
  assert.equal(err.metaClass, undefined);
  assert.equal(err.httpStatus, 400);
});
