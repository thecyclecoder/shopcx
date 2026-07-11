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

// Minimal SpecRow — renderSpecRow only reads title/owner/parent/blocked_by/summary/why/what/phases[].{id,title,body,verification,why,what}.
function rowWith(
  phases: Array<{ id: string; title: string; body: string; verification: string | null; why?: string | null; what?: string | null }>,
  extras: { why?: string | null; what?: string | null; summary?: string | null } = {},
): SpecRow {
  return {
    title: "T",
    owner: "platform",
    parent: "[[../functions/platform]] — mandate",
    blocked_by: [],
    summary: extras.summary ?? null,
    why: extras.why ?? null,
    what: extras.what ?? null,
    phases: phases.map((p, i) => ({ position: i + 1, status: "planned", why: p.why ?? null, what: p.what ?? null, ...p })),
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

// render-spec-row-emits-stored-why-what-intent Phase 1 — Vale + humans read the materialized markdown, so
// a spec whose intent is stored only in the specs.why / specs.what / spec_phases.why / spec_phases.what
// columns MUST render `**Why:**` and `**What:**` lines at both the spec level and under every phase heading.
// Without this, a fully-authored spec whose intent lives only in the columns was being bounced needs_fix.
test("spec-level why/what populated → renders `**Why:**` and `**What:**` above the summary", () => {
  const md = renderSpecRow(
    rowWith([{ id: "p1", title: "One", body: "b", verification: "- v" }], {
      why: "reviewers keep bouncing valid specs",
      what: "surface stored intent in the rendered markdown",
      summary: "the spec summary",
    }),
  );
  assert.match(md, /\*\*Why:\*\* reviewers keep bouncing valid specs/);
  assert.match(md, /\*\*What:\*\* surface stored intent in the rendered markdown/);
  // spec-level intent renders BEFORE the summary (order-sensitive so Vale sees intent up top).
  const whyIdx = md.indexOf("**Why:** reviewers");
  const summaryIdx = md.indexOf("the spec summary");
  assert.ok(whyIdx > 0 && summaryIdx > 0 && whyIdx < summaryIdx, "spec-level Why must render before the summary");
});

test("per-phase why/what populated → renders `**Why:**` and `**What:**` under every phase heading", () => {
  const md = renderSpecRow(
    rowWith([
      { id: "p1", title: "First", body: "first body", verification: "- v1", why: "unblock the caller", what: "add the field" },
      { id: "p2", title: "Second", body: "second body", verification: "- v2", why: "make it idempotent", what: "skip on inline" },
    ]),
  );
  // Both phase headings render, each followed by its own Why + What.
  assert.match(md, /## Phase 1 — First\n\*\*Why:\*\* unblock the caller\n\*\*What:\*\* add the field/);
  assert.match(md, /## Phase 2 — Second\n\*\*Why:\*\* make it idempotent\n\*\*What:\*\* skip on inline/);
});

test("row with populated spec-level AND per-phase why/what → renders `**Why:**` + `**What:**` at BOTH levels", () => {
  const md = renderSpecRow(
    rowWith(
      [{ id: "p1", title: "Only phase", body: "b", verification: "- v", why: "phase why", what: "phase what" }],
      { why: "spec why", what: "spec what" },
    ),
  );
  assert.match(md, /\*\*Why:\*\* spec why/);
  assert.match(md, /\*\*What:\*\* spec what/);
  assert.match(md, /## Phase 1 — Only phase\n\*\*Why:\*\* phase why\n\*\*What:\*\* phase what/);
});

test("row with null/empty why/what → no `**Why:**`/`**What:**` line emitted (safe default)", () => {
  const md = renderSpecRow(rowWith([{ id: "p1", title: "One", body: "b", verification: "- v" }]));
  assert.doesNotMatch(md, /\*\*Why:\*\*/);
  assert.doesNotMatch(md, /\*\*What:\*\*/);
});
