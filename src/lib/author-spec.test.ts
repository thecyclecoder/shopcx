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
  assertEveryNodeHasIntent,
  assertEveryPhaseHasChecks,
  assertIntentIsPlainLanguage,
  extractIntentHeaders,
  EmptyPhaseBodyError,
  MissingVerificationError,
  MissingIntentError,
} from "./author-spec";
import { parseVerificationBlobToChecks } from "./spec-phase-checks-table";
import { parseBrainRefsLineToSlugs } from "./spec-brain-refs-table";
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
        why: null,
        what: null,
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

// ── pm-structured-intent-and-refs Phase 1 — intent gate + extractor + lint ──

test("spec with empty why throws MissingIntentError", () => {
  assert.throws(
    () => assertEveryNodeHasIntent("no-why", { why: "", what: "when it ships, X changes" }, []),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError, `expected MissingIntentError, got ${e}`);
      assert.match((e as Error).message, /no WHY/);
      return true;
    },
  );
});

test("spec with empty what throws MissingIntentError", () => {
  assert.throws(
    () =>
      assertEveryNodeHasIntent(
        "no-what",
        { why: "we need this because X", what: "   " },
        [{ title: "P1", why: "w", what: "x" }],
      ),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError);
      assert.match((e as Error).message, /no WHAT/);
      return true;
    },
  );
});

test("phase with missing intent fails with slug + position + title", () => {
  assert.throws(
    () =>
      assertEveryNodeHasIntent(
        "phase-no-intent",
        { why: "spec why", what: "spec what" },
        [
          { title: "P1", why: "why 1", what: "what 1" },
          { title: "P2", why: "", what: "" },
        ],
      ),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError);
      assert.match((e as Error).message, /phase-no-intent/);
      assert.match((e as Error).message, /phase 2 \(P2\)/);
      assert.match((e as Error).message, /no why \+ no what/);
      return true;
    },
  );
});

test("intent lint rejects code fences", () => {
  assert.throws(
    () => assertIntentIsPlainLanguage("spec", "why", "we need this ```code``` for reasons"),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError);
      assert.match((e as Error).message, /code fence/);
      return true;
    },
  );
});

test("intent lint rejects file:line refs", () => {
  assert.throws(
    () => assertIntentIsPlainLanguage("spec", "what", "we fix src/lib/foo.ts:123"),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError);
      assert.match((e as Error).message, /file:line/);
      return true;
    },
  );
});

test("intent lint rejects **Header:** lines", () => {
  assert.throws(
    () => assertIntentIsPlainLanguage("spec", "why", "**Owner:** platform\nintent here"),
    (e: unknown) => {
      assert.ok(e instanceof MissingIntentError);
      assert.match((e as Error).message, /metadata header/);
      return true;
    },
  );
});

test("valid intent passes both gates", () => {
  assert.doesNotThrow(() =>
    assertEveryNodeHasIntent(
      "ok",
      {
        why: "The board detail page is unreadable because the intent is buried.",
        what: "When this ships, every spec's detail page leads with a plain-language intent header.",
      },
      [
        {
          title: "Add why/what columns",
          why: "Every level of the PM tree needs the plain-language layer humans and agents share.",
          what: "When this ships, the DB carries why + what on specs, phases, milestones, and goals.",
        },
      ],
    ),
  );
});

test("extractIntentHeaders pulls **Why:** + **What:** from markdown", () => {
  const md = [
    "# Spec title",
    "",
    "**Owner:** [[../functions/platform]]",
    "**Why:** we need the shared intent layer so humans + agents both read the detail page",
    "**What:** when this ships, the PM tree carries plain-language why + what everywhere",
    "",
    "## Phase 1 — Setup",
  ].join("\n");
  const got = extractIntentHeaders(md);
  assert.match(got.why ?? "", /shared intent layer/);
  assert.match(got.what ?? "", /plain-language why \+ what/);
});

test("extractIntentHeaders returns nulls when headers are absent", () => {
  const md = "# Title\n\n**Owner:** platform\n\n## Phase 1 — Do it";
  const got = extractIntentHeaders(md);
  assert.equal(got.why, null);
  assert.equal(got.what, null);
});

// ── pm-structured-intent-and-refs Phase 3 — structured verification checks ──

test("assertEveryPhaseHasChecks throws when a phase has zero checks", () => {
  assert.throws(
    () => assertEveryPhaseHasChecks("no-checks", [{ title: "P1", checks: [] }]),
    (e: unknown) => {
      assert.ok(e instanceof MissingVerificationError);
      assert.match((e as Error).message, /zero structured checks/);
      return true;
    },
  );
});

test("assertEveryPhaseHasChecks passes when every phase has ≥1 check", () => {
  assert.doesNotThrow(() =>
    assertEveryPhaseHasChecks("ok", [
      { title: "P1", checks: [{ position: 1, description: "On X, do Y → expect Z", kind: "auto" }] },
    ]),
  );
});

test("parseVerificationBlobToChecks splits bullet lines into rows", () => {
  const blob = [
    "- On the repo, run `npx tsc --noEmit` → expect clean",
    "- On /dashboard, load the roadmap → expect the intent header",
  ].join("\n");
  const checks = parseVerificationBlobToChecks(blob);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].position, 1);
  assert.match(checks[0].description, /tsc --noEmit/);
  assert.equal(checks[0].kind, "auto");
});

test("parseVerificationBlobToChecks returns [] for empty input", () => {
  assert.deepEqual(parseVerificationBlobToChecks(null), []);
  assert.deepEqual(parseVerificationBlobToChecks(""), []);
});

// ── pm-structured-intent-and-refs Phase 2 — structured brain refs ──

test("parseBrainRefsLineToSlugs pulls kind/name pairs from wikilinks", () => {
  const line = "**Brain refs:** [[../libraries/author-spec]] · [[../tables/specs]] · [[../inngest/spec-review-on-mutate]]";
  const slugs = parseBrainRefsLineToSlugs(line);
  assert.deepEqual(slugs, [
    "libraries/author-spec",
    "tables/specs",
    "inngest/spec-review-on-mutate",
  ]);
});

test("parseBrainRefsLineToSlugs dedupes duplicates", () => {
  const line = "[[../libraries/foo]] [[../libraries/foo]]";
  const slugs = parseBrainRefsLineToSlugs(line);
  assert.deepEqual(slugs, ["libraries/foo"]);
});
