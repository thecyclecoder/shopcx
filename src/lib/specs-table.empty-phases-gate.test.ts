/**
 * Unit tests for the unconditional empty-phase-list rail (spec-cannot-exist-without-phases Phase 1).
 * Pins the shape defect that let 3 phase-less specs land on 2026-07-20: `upsertSpec` writes the parent
 * `specs` row first and then loops over phases, so an empty list silently created a spec that could
 * BUILD but never MERGE (no phases → no `spec_phase_checks` → promote-on-green tests gate never green).
 *
 * These tests exercise the rail synchronously — the guard fires BEFORE `createAdminClient()` and BEFORE
 * `assertUpsertFullyAuthored`, so no Supabase client and no env vars are required. Run:
 *   npx tsx --test src/lib/specs-table.empty-phases-gate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { upsertSpec, EmptySpecPhasesError } from "@/lib/specs-table";

test("EmptySpecPhasesError is exported, names the slug + the invariant", () => {
  const err = new EmptySpecPhasesError("my-slug");
  assert.equal(err.name, "EmptySpecPhasesError");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof EmptySpecPhasesError);
  assert.match(err.message, /`my-slug`/);
  assert.match(err.message, /phase list is empty/);
  assert.match(err.message, /spec_phase_checks/);
  assert.match(err.message, /unmergeable PR/);
});

test("upsertSpec throws EmptySpecPhasesError on an empty phase list — the invariant applies to insert AND update", async () => {
  const baseRow = {
    slug: "does-not-touch-db",
    title: "T",
    summary: "s",
    owner: "platform",
    parent: "platform",
    blocked_by: [],
    priority: null,
    deferred: false,
    intended_status: null,
    auto_build: false,
    why: "w",
    what: "c",
  };
  await assert.rejects(
    () => upsertSpec("00000000-0000-0000-0000-000000000000", baseRow, []),
    (err: unknown) =>
      err instanceof EmptySpecPhasesError &&
      /`does-not-touch-db`/.test((err as Error).message),
  );
});
