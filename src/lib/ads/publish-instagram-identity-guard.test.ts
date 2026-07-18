/**
 * Unit tests for the Meta publisher's missing-Instagram-identity guard —
 * "Guard Meta publisher when Instagram identity is missing" spec Phase 1.
 *
 * The guard is a pure predicate; the publisher (`src/lib/inngest/ad-tool.ts`)
 * calls it after the publish path is resolved and, on refusal, marks the
 * job `failed` with the stable `missing_instagram_identity` reason and
 * returns without throwing.
 *
 * Run:  npx tsx --test src/lib/ads/publish-instagram-identity-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MISSING_INSTAGRAM_IDENTITY_REASON,
  isInstagramIdentityMissing,
  publishPathRequiresInstagramIdentity,
  shouldRefuseForMissingInstagramIdentity,
} from "./publish-instagram-identity-guard";

test("MISSING_INSTAGRAM_IDENTITY_REASON is the stable fingerprint the publisher writes", () => {
  assert.equal(MISSING_INSTAGRAM_IDENTITY_REASON, "missing_instagram_identity");
});

test("publishPathRequiresInstagramIdentity — placement-customized paths require IG", () => {
  assert.equal(publishPathRequiresInstagramIdentity({ placementReady: true, dual: true }), true);
  assert.equal(publishPathRequiresInstagramIdentity({ placementReady: false, dual: true }), true);
});

test("publishPathRequiresInstagramIdentity — single-asset path does NOT require IG", () => {
  assert.equal(publishPathRequiresInstagramIdentity({ placementReady: false, dual: false }), false);
});

test("isInstagramIdentityMissing — null / undefined / blank all count as missing", () => {
  assert.equal(isInstagramIdentityMissing(null), true);
  assert.equal(isInstagramIdentityMissing(undefined), true);
  assert.equal(isInstagramIdentityMissing(""), true);
  assert.equal(isInstagramIdentityMissing("   "), true);
});

test("isInstagramIdentityMissing — a real IG business account id is present", () => {
  assert.equal(isInstagramIdentityMissing("17841400000000000"), false);
});

test("shouldRefuseForMissingInstagramIdentity — dual-asset publish without IG refuses", () => {
  assert.equal(
    shouldRefuseForMissingInstagramIdentity({
      placementReady: false,
      dual: true,
      instagramUserId: null,
    }),
    true,
  );
});

test("shouldRefuseForMissingInstagramIdentity — 3-bucket PAC publish without IG refuses", () => {
  assert.equal(
    shouldRefuseForMissingInstagramIdentity({
      placementReady: true,
      dual: true,
      instagramUserId: "",
    }),
    true,
  );
});

test("shouldRefuseForMissingInstagramIdentity — dual publish WITH IG proceeds", () => {
  assert.equal(
    shouldRefuseForMissingInstagramIdentity({
      placementReady: true,
      dual: true,
      instagramUserId: "17841400000000000",
    }),
    false,
  );
});

test("shouldRefuseForMissingInstagramIdentity — single-asset publish without IG proceeds", () => {
  assert.equal(
    shouldRefuseForMissingInstagramIdentity({
      placementReady: false,
      dual: false,
      instagramUserId: null,
    }),
    false,
  );
});
