/**
 * Idle-spec backstop pure predicate (idle-spec-backstop-escalates-to-ceo Phase 1).
 *
 * Pins `lastForwardProgressMs` — the clock that decides whether a spec has MOVED: the MAX of a phase
 * status change (spec_phases.updated_at), the spec row changing (specs.updated_at), and the most recent
 * build job that pushed a PR (agent_jobs.created_at). The idle backstop + the self-retirement sweep both
 * read this one definition, so a drift here would make a card that never retires (or retires too early).
 *
 *   npx tsx --test src/lib/mario.idle-spec-backstop.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lastForwardProgressMs } from "./mario";
import type { SpecPhaseRow } from "./specs-table";

const phaseAt = (iso: string): SpecPhaseRow => ({ updated_at: iso } as unknown as SpecPhaseRow);

test("lastForwardProgressMs — takes the MAX across spec, phases, and PR-bearing build jobs", () => {
  const spec = {
    updated_at: "2026-11-01T00:00:00.000Z",
    phases: [phaseAt("2026-11-03T00:00:00.000Z"), phaseAt("2026-11-02T00:00:00.000Z")],
  };
  // A build job that pushed a PR is the newest signal → it wins.
  const got = lastForwardProgressMs(spec, [{ created_at: "2026-11-05T00:00:00.000Z" }]);
  assert.equal(got, Date.parse("2026-11-05T00:00:00.000Z"));
});

test("lastForwardProgressMs — a stale spec with no PR builds reads its newest phase change", () => {
  const spec = {
    updated_at: "2026-10-01T00:00:00.000Z",
    phases: [phaseAt("2026-10-20T00:00:00.000Z")],
  };
  const got = lastForwardProgressMs(spec, []);
  assert.equal(got, Date.parse("2026-10-20T00:00:00.000Z"));
});

test("lastForwardProgressMs — no parseable stamps → 0 (maximally idle)", () => {
  const spec = { updated_at: null as unknown as string, phases: [] };
  assert.equal(lastForwardProgressMs(spec, []), 0);
});

test("lastForwardProgressMs — ignores unparseable timestamps, keeps the valid max", () => {
  const spec = {
    updated_at: "not-a-date",
    phases: [phaseAt("2026-11-04T00:00:00.000Z"), phaseAt("garbage")],
  };
  assert.equal(lastForwardProgressMs(spec, [{ created_at: "" }]), Date.parse("2026-11-04T00:00:00.000Z"));
});
