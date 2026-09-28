/**
 * Unit tests for the UUID-shape guard at `specs-table.getSpec`
 * (specs-table-get-spec-uuid-guard-surface-slug-swap-caller).
 *
 * Named failing state: the Control Tower captured 23 postgres ERRORs over 2 days of the shape
 * `invalid input syntax for type uuid: "<a-spec-slug>"` on `public.get_spec_with_phases($1::uuid, $2::text)`.
 * Every direct caller passes workspaceId in the first slot at compile time, so an upstream path is
 * mislabeling a slug as a workspaceId at runtime — and because the error is thrown by Postgres (not
 * by our SDK), the JS stack trace of the mis-caller is LOST, making the real bug uninvestigable from
 * the log alone. A cheap boundary guard at `getSpec` fingerprints the offending value + throws a JS
 * Error the next time it fires, so the caller lands in monitoring.
 *
 * Pure guard — fires BEFORE the cache read and BEFORE the pooled / supabase-js dispatch, so a
 * slug-shaped workspaceId rejects without touching pg-pool or `createAdminClient()`. Run:
 *   npx tsx --test src/lib/specs-table.get-spec-uuid-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// Prevent an accidental real DB round-trip if a valid-UUID case somehow slips past the guard. The
// guard tests never need env creds — but a wrong-fingerprint pass here would otherwise reach
// `createAdminClient()` and either hang on a live URL or spam a real request; a localhost:1 URL
// fails fast (ECONNREFUSED), and the tests only assert on the guard's message, not the fallthrough.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-only-key";

import { getSpec, clearSpecCacheForTests } from "@/lib/specs-table";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

test("slug-shaped workspaceId → throws a descriptive JS Error naming the bad value (arg-order swap fingerprint)", async () => {
  await assert.rejects(
    () => getSpec("cx-agent-sdk", "phase-1"),
    (err: unknown) =>
      err instanceof Error &&
      /\[specs-table\.getSpec\]/.test(err.message) &&
      /workspaceId must be a UUID/.test(err.message) &&
      /"cx-agent-sdk"/.test(err.message) &&
      /check arg order/.test(err.message),
  );
});

test("empty-string workspaceId → same guard fingerprint (an unset value must not fall through to postgres)", async () => {
  await assert.rejects(
    () => getSpec("", "any-slug"),
    (err: unknown) =>
      err instanceof Error && /workspaceId must be a UUID/.test(err.message),
  );
});

test("almost-UUID (missing a hex digit) → still rejected — the guard uses a strict shape match", async () => {
  await assert.rejects(
    () => getSpec("11111111-2222-3333-4444-55555555555", "any-slug"),
    (err: unknown) =>
      err instanceof Error && /workspaceId must be a UUID/.test(err.message),
  );
});

test("valid UUID → guard does NOT throw (it passes through to the pooled / supabase-js dispatch)", async () => {
  clearSpecCacheForTests();
  let caught: unknown;
  try {
    await getSpec(VALID_UUID, "slug-that-does-not-exist");
  } catch (e) {
    caught = e;
  }
  // The pooled path is wrapped in try/catch and any failure falls through; the supabase-js path may
  // then error against the invalid host — that is FINE. What we pin: the guard's own message must
  // NOT appear on a real UUID. If nothing threw at all, that's also a pass (guard did not fire).
  if (caught instanceof Error) {
    assert.doesNotMatch(caught.message, /workspaceId must be a UUID/);
  }
});

test("uppercase UUID → accepted (the guard is case-insensitive, matching pg's uuid parser)", async () => {
  clearSpecCacheForTests();
  let caught: unknown;
  try {
    await getSpec(VALID_UUID.toUpperCase(), "slug-that-does-not-exist");
  } catch (e) {
    caught = e;
  }
  if (caught instanceof Error) {
    assert.doesNotMatch(caught.message, /workspaceId must be a UUID/);
  }
});
