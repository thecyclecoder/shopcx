/**
 * Unit tests for the Meta "target ad set unavailable" classifier.
 *
 * These are the exact named failing states from the spec: a permanent Meta
 * object-missing / missing-permission response coming out of `createAd` must
 * be classified as unavailable so the publisher can fail the job closed with
 * a stable `meta_adset_unavailable` reason instead of rethrowing (which turns
 * a permanent config error into a Vercel Inngest crash + Control Tower page).
 *
 * Runs via: npx tsx --test src/lib/ads/publish-adset-unavailable-classifier.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_ADSET_FAILURE_REASON,
  isMetaAdsetUnavailableError,
} from "./publish-adset-unavailable-classifier";

// Mirror the `graphError` shape from src/lib/meta/graph-retry.ts (the only source of thrown Meta errors).
function makeGraphError(opts: {
  message: string;
  metaCode?: number;
  metaSubcode?: number;
  httpStatus?: number;
}): Error {
  const e = new Error(opts.message) as Error & Record<string, unknown>;
  if (opts.metaCode !== undefined) e.metaCode = opts.metaCode;
  if (opts.metaSubcode !== undefined) e.metaSubcode = opts.metaSubcode;
  if (opts.httpStatus !== undefined) e.httpStatus = opts.httpStatus;
  return e;
}

test("stable reason string is the fingerprint the publisher/recommendation writes", () => {
  assert.equal(STALE_ADSET_FAILURE_REASON, "meta_adset_unavailable");
});

test("canonical Meta subcode 33 (Object does not exist) → unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: Object does not exist, cannot be loaded due to missing permission or does not support this operation",
    metaCode: 100,
    metaSubcode: 33,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), true);
});

test("Meta permission code 200 → unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: (#200) Permissions error",
    metaCode: 200,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), true);
});

test("Meta permission code 803 → unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: (#803) Some of the aliases you requested do not exist",
    metaCode: 803,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), true);
});

test("400 with 'does not exist' message but no surfaced subcode → unavailable (message-shape fallback)", () => {
  const err = makeGraphError({
    message: "meta_400: The ad set does not exist",
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), true);
});

test("400 with 'cannot be loaded' message → unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: Object cannot be loaded",
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), true);
});

test("expired token (code 190) → NOT classified as adset-unavailable (it's an auth problem)", () => {
  const err = makeGraphError({
    message: "meta_400: (#190) Invalid OAuth 2.0 Access Token",
    metaCode: 190,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), false);
});

test("transient service error (code 2, retried upstream) → NOT unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: Service temporarily unavailable",
    metaCode: 2,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), false);
});

test("plain validation 400 with unrelated body → NOT unavailable", () => {
  const err = makeGraphError({
    message: "meta_400: Invalid parameter — bid amount too low",
    metaCode: 100,
    httpStatus: 400,
  });
  assert.equal(isMetaAdsetUnavailableError(err), false);
});

test("HTTP 500 with 'does not exist' body → NOT unavailable (5xx is transient territory)", () => {
  const err = makeGraphError({
    message: "meta_500: does not exist",
    httpStatus: 500,
  });
  assert.equal(isMetaAdsetUnavailableError(err), false);
});

test("null / non-error inputs → false, never throws", () => {
  assert.equal(isMetaAdsetUnavailableError(null), false);
  assert.equal(isMetaAdsetUnavailableError(undefined), false);
  assert.equal(isMetaAdsetUnavailableError("string"), false);
  assert.equal(isMetaAdsetUnavailableError(42), false);
  assert.equal(isMetaAdsetUnavailableError({}), false);
});
