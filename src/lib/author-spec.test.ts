/**
 * Unit tests for the author-spec gates (spec-body-never-silently-empty Phase 1). Pins:
 *
 *   - a PHASELESS structured spec throws (`assertEveryPhaseHasBody` catches it) rather than authoring a
 *     0-phase row that would silently complete with nothing merged;
 *   - an EMPTY-BODY structured phase throws (`EmptyPhaseBodyError`) BEFORE the DB write, so the un-buildable
 *     spec never reaches `public.spec_phases`;
 *   - `assertEveryPhaseHasVerification` still throws for the untestable case (regression guard so the two
 *     gates don't blur into each other);
 *   - `unbuildableReason` from build-spec-materializer flags a 0-phase, 0-summary row (belt-and-suspenders on
 *     the generic build gate).
 *
 * Pure helpers — no I/O, no DB. Run:
 *   npx tsx --test src/lib/author-spec.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEveryPhaseHasBody,
  assertEveryPhaseHasVerification,
  EmptyPhaseBodyError,
  MissingVerificationError,
} from "./author-spec";
import { unbuildableReason, specHasBuildableContent } from "./build-spec-materializer";
import type { SpecRow } from "./specs-table";

/** Minimal SpecRow-shaped fixture — only the fields the buildability check reads (phases + summary). */
function makeRow(overrides: { summary?: string | null; phases?: SpecRow["phases"] }): SpecRow {
  return {
    summary: overrides.summary ?? null,
    phases: overrides.phases ?? [],
  } as unknown as SpecRow;
}

test("phaseless structured spec fails loud", () => {
  assert.throws(() => assertEveryPhaseHasBody("spec-empty", []), (e: unknown) => {
    assert.ok(e instanceof EmptyPhaseBodyError, `expected EmptyPhaseBodyError, got ${e}`);
    assert.match((e as Error).message, /has no phases/);
    return true;
  });
});

test("empty-body phase fails loud with slug + position", () => {
  const phases = [
    { title: "Add the index", body: "Migration + apply-script; tsc-clean." },
    { title: "Backfill the column", body: "   " }, // whitespace-only → empty
  ];
  assert.throws(() => assertEveryPhaseHasBody("db-index-orders", phases), (e: unknown) => {
    assert.ok(e instanceof EmptyPhaseBodyError, `expected EmptyPhaseBodyError, got ${e}`);
    assert.match((e as Error).message, /db-index-orders/);
    assert.match((e as Error).message, /phase 2 \(Backfill the column\)/);
    assert.match((e as Error).message, /empty body/);
    return true;
  });
});

test("all-non-empty phases pass the body gate", () => {
  const phases = [
    { title: "P1", body: "do the thing" },
    { title: "P2", body: "do the other thing" },
  ];
  assert.doesNotThrow(() => assertEveryPhaseHasBody("ok", phases));
});

test("empty-verification phase still fails via the verification gate", () => {
  const phases = [
    { title: "P1", body: "guidance goes here", verification: null },
  ];
  assert.throws(() => assertEveryPhaseHasVerification("no-verify", phases), (e: unknown) => {
    assert.ok(e instanceof MissingVerificationError, `expected MissingVerificationError, got ${e}`);
    return true;
  });
});

test("unbuildableReason flags a 0-phase 0-summary row", () => {
  const row = makeRow({ summary: null, phases: [] });
  assert.equal(specHasBuildableContent(row), false);
  assert.match(unbuildableReason(row), /no spec_phases rows/);
});

test("unbuildableReason flags phases with empty titles + empty bodies", () => {
  const row = makeRow({
    summary: null,
    phases: [
      {
        id: "p1",
        spec_id: "s1",
        position: 1,
        title: "",
        body: "",
        status: "planned",
        pr: null,
        merge_sha: null,
        build_sha: null,
        verification: null,
        kind: "phase",
        origin_check_keys: [],
        created_at: "2026-07-02T00:00:00Z",
        updated_at: "2026-07-02T00:00:00Z",
      },
    ],
  });
  assert.equal(specHasBuildableContent(row), false);
  assert.match(unbuildableReason(row), /every one is empty/);
});

test("summary-only spec (one-shot) is buildable", () => {
  const row = makeRow({ summary: "The whole thing ships in one PR — the summary carries the intent." });
  assert.equal(specHasBuildableContent(row), true);
  assert.equal(unbuildableReason(row), "");
});
