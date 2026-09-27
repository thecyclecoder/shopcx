/**
 * Pins the `isValidAmazonConnectionId` guard used by both Amazon sync
 * handlers to short-circuit malformed events before the `load-connection`
 * step asks Supabase to compare a UUID column to a non-UUID string
 * (docs/brain/specs/amazon-sync-guard-malformed-connection-id.md Phase 1).
 *
 * The Control Tower signature that triggered this spec was PostgREST
 * rejecting `connection_id="undefined"` against `amazon_connections.id`
 * (UUID). Any non-UUID value — undefined, null, empty, the literal string
 * "undefined", or an arbitrary token — must fail the guard so the handler
 * returns { status: "skipped", reason: "invalid_connection_id" } without
 * ever querying Supabase.
 *
 * Run:
 *   npx tsx --test src/lib/inngest/amazon-sync.connection-id-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { isValidAmazonConnectionId } from "./amazon-sync";

test("accepts a canonical UUID connection id", () => {
  assert.equal(
    isValidAmazonConnectionId("11111111-2222-4333-8444-555555555555"),
    true,
  );
});

test("accepts an uppercase UUID connection id", () => {
  assert.equal(
    isValidAmazonConnectionId("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
    true,
  );
});

test("rejects the literal 'undefined' string from a malformed event", () => {
  assert.equal(isValidAmazonConnectionId("undefined"), false);
});

test("rejects an actual undefined connection id", () => {
  assert.equal(isValidAmazonConnectionId(undefined), false);
});

test("rejects null and empty string connection ids", () => {
  assert.equal(isValidAmazonConnectionId(null), false);
  assert.equal(isValidAmazonConnectionId(""), false);
});

test("rejects a non-UUID token", () => {
  assert.equal(isValidAmazonConnectionId("not-a-uuid"), false);
  assert.equal(isValidAmazonConnectionId("1234"), false);
});

test("rejects a UUID with extra whitespace / trailing chars", () => {
  assert.equal(
    isValidAmazonConnectionId(" 11111111-2222-4333-8444-555555555555"),
    false,
  );
  assert.equal(
    isValidAmazonConnectionId("11111111-2222-4333-8444-555555555555-extra"),
    false,
  );
});

test("rejects non-string values (numbers, objects)", () => {
  assert.equal(isValidAmazonConnectionId(42 as unknown), false);
  assert.equal(isValidAmazonConnectionId({} as unknown), false);
});
