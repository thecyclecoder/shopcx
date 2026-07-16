/**
 * Unit tests for the TERMINAL-SPEC ENQUEUE GUARD — mario-enqueue-terminal-spec-guard
 * (CEO 2026-07-16, "Mario must not work on archived/folded specs", absolute).
 *
 * `enqueueMarioJob` refuses any candidate whose spec is terminal (folded / deferred / derived-shipped)
 * via the pure `isMarioTerminalSpec` predicate — overriding the survivor-filter (d) relax for the
 * orphaned_folded_pr ninth source, which the moment the box regained pipeline visibility mass-enqueued
 * 65 Max-session jobs against just-folded pipeline specs. These pin the pure predicate; the named
 * failing state is "a folded spec is enqueued for a Max session".
 *
 * Pure predicate — no I/O, no DB (the enqueue-chokepoint read of the spec row lives in enqueueMarioJob).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isMarioTerminalSpec } from "./mario";
import type { SpecRow } from "./specs-table";

const row = (over: Partial<Pick<SpecRow, "status" | "phases">>): Pick<SpecRow, "status" | "phases"> => ({
  status: null,
  phases: [],
  ...over,
});

test("folded spec → terminal (the flood class: 50 folded pipeline specs)", () => {
  assert.equal(isMarioTerminalSpec(row({ status: "folded", phases: [{ status: "shipped" } as never] })), true);
});

test("deferred spec → terminal (parked on purpose)", () => {
  assert.equal(isMarioTerminalSpec(row({ status: "deferred" })), true);
});

test("derived-shipped (every phase shipped, NULL raw status) → terminal", () => {
  assert.equal(
    isMarioTerminalSpec(row({ status: null, phases: [{ status: "shipped" }, { status: "shipped" }] as never })),
    true,
  );
});

test("planned spec (a live in-flight spec) → NOT terminal (Mario may legitimately unstick it)", () => {
  assert.equal(isMarioTerminalSpec(row({ status: "planned", phases: [{ status: "planned" } as never] })), false);
});

test("in_progress with a mix of shipped + unshipped phases → NOT terminal (not every phase shipped)", () => {
  assert.equal(
    isMarioTerminalSpec(
      row({ status: "in_progress", phases: [{ status: "shipped" }, { status: "in_progress" }] as never }),
    ),
    false,
  );
});

test("no phases + NULL status → NOT terminal (an empty derived rollup is not 'shipped')", () => {
  assert.equal(isMarioTerminalSpec(row({ status: null, phases: [] })), false);
});
