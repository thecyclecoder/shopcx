/**
 * Unit tests for renderSpecRow's verification-checks-source-of-truth flip. Pins:
 *   - `### Verification` renders from the typed spec_phase_checks rows (`- {description}`) when supplied;
 *   - falls back to the `spec_phases.verification` column for a phase with no rows (legacy / backward compat);
 *   - called WITHOUT the map, renders from the column exactly as before.
 *
 * Pure — no I/O, no DB. Run:  npx tsx --test src/lib/build-spec-materializer.render.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderSpecRow } from "@/lib/build-spec-materializer";
import type { SpecRow } from "@/lib/specs-table";

// Minimal SpecRow — renderSpecRow only reads title/owner/parent/blocked_by/summary/phases[].{id,title,body,verification}.
function rowWith(phases: Array<{ id: string; title: string; body: string; verification: string | null }>): SpecRow {
  return {
    title: "T",
    owner: "platform",
    parent: "[[../functions/platform]] — mandate",
    blocked_by: [],
    summary: null,
    phases: phases.map((p, i) => ({ position: i + 1, status: "planned", ...p })),
  } as unknown as SpecRow;
}

test("no checks map → renders `### Verification` from the column (backward compatible)", () => {
  const md = renderSpecRow(rowWith([{ id: "p1", title: "One", body: "b", verification: "- On /x expect 200" }]));
  assert.match(md, /### Verification\n- On \/x expect 200/);
});

test("checks map present → renders `### Verification` from the typed rows", () => {
  const map = new Map<string, { description: string }[]>([
    ["p1", [{ description: "On /x expect 200" }, { description: "On /y expect 404" }]],
  ]);
  const md = renderSpecRow(rowWith([{ id: "p1", title: "One", body: "b", verification: "- STALE column value" }]), map);
  assert.match(md, /### Verification\n- On \/x expect 200\n- On \/y expect 404/);
  assert.doesNotMatch(md, /STALE column value/); // rows win over the column
});

test("phase absent from the map → falls back to the column (mixed spec)", () => {
  const map = new Map<string, { description: string }[]>([["p1", [{ description: "row check" }]]]);
  const md = renderSpecRow(
    rowWith([
      { id: "p1", title: "One", body: "b", verification: "- col1" },
      { id: "p2", title: "Two", body: "b", verification: "- col2 fallback" },
    ]),
    map,
  );
  assert.match(md, /- row check/); // p1 from rows
  assert.match(md, /- col2 fallback/); // p2 from column fallback
});

test("empty checks list for a phase → falls back to the column (never emits an empty Verification)", () => {
  const map = new Map<string, { description: string }[]>([["p1", []]]);
  const md = renderSpecRow(rowWith([{ id: "p1", title: "One", body: "b", verification: "- col only" }]), map);
  assert.match(md, /### Verification\n- col only/);
});
