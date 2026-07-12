/**
 * Unit tests for src/lib/cockpit-resolver.ts — director-sms-cockpit-per-director Phase 1
 * verification bullet #4 ("cockpit-resolver fed garbage → expect null") and the SDK helper's
 * bullet #3 ("unknown or too-short token → expect null").
 *
 * These test the LENGTH SHORT-CIRCUITS (pre-DB): the resolver rejects a wrong-length token
 * BEFORE any admin client is created, so we can prove the null branch without touching
 * Supabase. The DB round-trip verification (bullets #1/#2/#4-hit) belongs to an integration
 * test that hits a live director_coach_threads row; that's outside this unit's seam.
 *
 * Run: `tsx --test src/lib/cockpit-resolver.test.ts`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCockpitTokenAny } from "./cockpit-resolver";
import { resolveDirectorCockpitToken } from "./agents/director-coach-threads";

// Cast to bypass the SupabaseClient type: the resolver must NEVER call the client on a
// wrong-length token, so passing null is a live assertion that the guard fires first
// (a DB call would throw on the null receiver).
const NULL_ADMIN = null as unknown as Parameters<typeof resolveCockpitTokenAny>[0];

test("resolveCockpitTokenAny returns null for the empty string BEFORE hitting the DB", async () => {
  const r = await resolveCockpitTokenAny(NULL_ADMIN, "");
  assert.equal(r, null);
});

test("resolveCockpitTokenAny returns null for a short (< 48 char) token BEFORE hitting the DB", async () => {
  const r = await resolveCockpitTokenAny(NULL_ADMIN, "deadbeef");
  assert.equal(r, null);
});

test("resolveCockpitTokenAny returns null for a > 48 char token BEFORE hitting the DB", async () => {
  const r = await resolveCockpitTokenAny(NULL_ADMIN, "a".repeat(64));
  assert.equal(r, null);
});

test("resolveDirectorCockpitToken returns null for an empty token", async () => {
  const r = await resolveDirectorCockpitToken("");
  assert.equal(r, null);
});

test("resolveDirectorCockpitToken returns null for a wrong-length token", async () => {
  const r = await resolveDirectorCockpitToken("abcd");
  assert.equal(r, null);
});
