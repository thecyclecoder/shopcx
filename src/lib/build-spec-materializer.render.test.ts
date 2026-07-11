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

// render-spec-row-emits-stored-why-what-intent Phase 2 — NO DOUBLE EMIT. Some already-shipped specs baked
// `**Why:**`/`**What:**` into the summary body or phase body as a stopgap (marco-logistics-director-seat,
// director-chat-in-leash-execution). When the inline stopgap is present, the column-sourced line MUST be
// skipped so the render carries exactly one of each — never a duplicate.
function countLines(md: string, prefix: string): number {
  return md.split("\n").filter((l) => l.startsWith(prefix)).length;
}

test("summary already leads with **Why:** → do NOT emit the spec-level column Why (no duplicate)", () => {
  const md = renderSpecRow(
    rowWith([{ id: "p1", title: "One", body: "b", verification: "- v" }], {
      why: "column-sourced why",
      what: null,
      summary: "**Why:** inline stopgap why\n\nrest of summary",
    }),
  );
  assert.equal(countLines(md, "**Why:**"), 1);
  assert.match(md, /\*\*Why:\*\* inline stopgap why/);
  assert.doesNotMatch(md, /\*\*Why:\*\* column-sourced why/);
});

test("summary already leads with **What:** → do NOT emit the spec-level column What (no duplicate)", () => {
  const md = renderSpecRow(
    rowWith([{ id: "p1", title: "One", body: "b", verification: "- v" }], {
      why: null,
      what: "column-sourced what",
      summary: "**What:** inline stopgap what\n\nrest",
    }),
  );
  assert.equal(countLines(md, "**What:**"), 1);
  assert.match(md, /\*\*What:\*\* inline stopgap what/);
  assert.doesNotMatch(md, /\*\*What:\*\* column-sourced what/);
});

test("summary carries inline **Why:** but NOT **What:** → column-sourced What still emits, Why does not", () => {
  const md = renderSpecRow(
    rowWith([{ id: "p1", title: "One", body: "b", verification: "- v" }], {
      why: "column why",
      what: "column what",
      summary: "**Why:** inline why\n\nbody",
    }),
  );
  assert.equal(countLines(md, "**Why:**"), 1);
  assert.equal(countLines(md, "**What:**"), 1);
  assert.match(md, /\*\*Why:\*\* inline why/);
  assert.match(md, /\*\*What:\*\* column what/);
});

test("phase body already leads with **Why:** → do NOT emit the phase-level column Why", () => {
  const md = renderSpecRow(
    rowWith([
      {
        id: "p1",
        title: "One",
        body: "**Why:** inline phase why\n\nphase body",
        verification: "- v",
        why: "column phase why",
        what: null,
      },
    ]),
  );
  assert.equal(countLines(md, "**Why:**"), 1);
  assert.match(md, /\*\*Why:\*\* inline phase why/);
  assert.doesNotMatch(md, /\*\*Why:\*\* column phase why/);
});

test("phase body already leads with **What:** → do NOT emit the phase-level column What", () => {
  const md = renderSpecRow(
    rowWith([
      {
        id: "p1",
        title: "One",
        body: "**What:** inline phase what",
        verification: "- v",
        why: null,
        what: "column phase what",
      },
    ]),
  );
  assert.equal(countLines(md, "**What:**"), 1);
  assert.match(md, /\*\*What:\*\* inline phase what/);
  assert.doesNotMatch(md, /\*\*What:\*\* column phase what/);
});

test("column-only intent at both levels → exactly one **Why:**/**What:** at each level (no duplicate)", () => {
  const md = renderSpecRow(
    rowWith(
      [
        {
          id: "p1",
          title: "First",
          body: "plain phase body no inline intent",
          verification: "- v",
          why: "phase why",
          what: "phase what",
        },
        {
          id: "p2",
          title: "Second",
          body: "another plain body",
          verification: "- v",
          why: "second phase why",
          what: "second phase what",
        },
      ],
      { why: "spec why", what: "spec what", summary: "plain summary no inline intent" },
    ),
  );
  // 1 spec-level Why + 2 phase-level Whys = 3 total; same for What.
  assert.equal(countLines(md, "**Why:**"), 3);
  assert.equal(countLines(md, "**What:**"), 3);
});

test("mixed: spec inline, one phase inline, one phase column-only → exactly one line at each locus", () => {
  const md = renderSpecRow(
    rowWith(
      [
        {
          id: "p1",
          title: "First",
          body: "**Why:** phase-1 inline why\n\nrest",
          verification: "- v",
          why: "phase-1 column why (should be skipped)",
          what: "phase-1 column what",
        },
        {
          id: "p2",
          title: "Second",
          body: "plain body",
          verification: "- v",
          why: "phase-2 column why",
          what: "phase-2 column what",
        },
      ],
      {
        why: "spec column why (should be skipped)",
        what: "spec column what",
        summary: "**Why:** spec inline why\n\nrest of summary",
      },
    ),
  );
  // Spec level: 1 Why (inline wins), 1 What (column emitted).
  // Phase 1: 1 Why (inline wins), 1 What (column emitted).
  // Phase 2: 1 Why (column), 1 What (column).
  // Total: 3 Why, 3 What.
  assert.equal(countLines(md, "**Why:**"), 3);
  assert.equal(countLines(md, "**What:**"), 3);
  assert.doesNotMatch(md, /\*\*Why:\*\* spec column why/);
  assert.doesNotMatch(md, /\*\*Why:\*\* phase-1 column why/);
  assert.match(md, /\*\*Why:\*\* spec inline why/);
  assert.match(md, /\*\*Why:\*\* phase-1 inline why/);
  assert.match(md, /\*\*Why:\*\* phase-2 column why/);
});
