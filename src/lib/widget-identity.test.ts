/**
 * Pins the chat-widget signed identity pass (src/lib/widget-identity.ts).
 *
 * The pure verifier is the security boundary: a pass only verifies when the HMAC signature matches
 * the workspace secret (constant-time) AND the expiry is in the future and ≤ 15 min ahead. Tampering
 * with the payload, using the wrong secret, or an expired/unbounded pass all return null. These are
 * hermetic — no DB, no decrypt — so they exercise the exact token format ShopGrowth signs.
 *
 * Run: npx tsx --test src/lib/widget-identity.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  signWidgetIdentityToken,
  verifyWidgetIdentityToken,
  MAX_IDENTITY_EXP_SKEW_MS,
  type WidgetIdentityPayload,
} from "./widget-identity";

const SECRET = "a-shared-per-workspace-secret-0123456789";
const WRONG_SECRET = "a-different-secret-abcdefghijklmnopqrst";
const NOW = 1_800_000_000_000; // fixed epoch ms for deterministic exp math

function payload(overrides: Partial<WidgetIdentityPayload> = {}): WidgetIdentityPayload {
  return {
    shop: "acme.myshopify.com",
    app: "shopgrowth",
    email: "Staff@Acme.com",
    name: "Acme Staff",
    exp: Math.floor(NOW / 1000) + 300, // 5 min ahead
    ...overrides,
  };
}

test("valid pass verifies and returns the identity (email lowercased)", () => {
  const token = signWidgetIdentityToken(SECRET, payload());
  const got = verifyWidgetIdentityToken(SECRET, token, NOW);
  assert.ok(got);
  assert.equal(got!.shop, "acme.myshopify.com");
  assert.equal(got!.app, "shopgrowth");
  assert.equal(got!.email, "staff@acme.com");
  assert.equal(got!.name, "Acme Staff");
});

test("tampered payload fails (signature no longer matches)", () => {
  const token = signWidgetIdentityToken(SECRET, payload());
  const [v, b64payload, sig] = token.split(".");
  // Flip the last base64url char of the payload — signature was over the original.
  const flipped = b64payload.slice(0, -1) + (b64payload.slice(-1) === "A" ? "B" : "A");
  const tampered = `${v}.${flipped}.${sig}`;
  assert.equal(verifyWidgetIdentityToken(SECRET, tampered, NOW), null);
});

test("expired pass fails (exp in the past)", () => {
  const token = signWidgetIdentityToken(SECRET, payload({ exp: Math.floor(NOW / 1000) - 1 }));
  assert.equal(verifyWidgetIdentityToken(SECRET, token, NOW), null);
});

test("pass expiring further than 15 min ahead fails (unbounded-lifetime guard)", () => {
  const farExp = Math.floor((NOW + MAX_IDENTITY_EXP_SKEW_MS + 60_000) / 1000);
  const token = signWidgetIdentityToken(SECRET, payload({ exp: farExp }));
  assert.equal(verifyWidgetIdentityToken(SECRET, token, NOW), null);
});

test("wrong secret fails (signature mismatch)", () => {
  const token = signWidgetIdentityToken(WRONG_SECRET, payload());
  assert.equal(verifyWidgetIdentityToken(SECRET, token, NOW), null);
});

test("malformed tokens fail closed", () => {
  for (const bad of ["", "not-a-token", "v1.onlytwo", "v2.abc.def", "v1..sig"]) {
    assert.equal(verifyWidgetIdentityToken(SECRET, bad, NOW), null, `should reject: ${bad}`);
  }
  assert.equal(verifyWidgetIdentityToken(SECRET, null, NOW), null);
  assert.equal(verifyWidgetIdentityToken("", signWidgetIdentityToken(SECRET, payload()), NOW), null);
});
