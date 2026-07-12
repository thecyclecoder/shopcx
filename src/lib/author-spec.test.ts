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
  assertEveryPhaseHasMachineCheck,
  assertIntentIsPlainLanguage,
  extractIntentHeaders,
  extractHumanReviewHeader,
  EmptyPhaseBodyError,
  MissingVerificationError,
  MissingIntentError,
  MissingMachineCheckError,
  assertValidParent,
  InvalidParentError,
  detectBareFunctionParent,
  autoAnchorBareFunctionParent,
  bestFitMandate,
} from "./author-spec";
import { computeUpsertAuthoringProblems } from "./specs-table";
import { resolveFunctionMandates, type FunctionMandate } from "./function-mandates";
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

// one-off-spec-parent — assertValidParent (bare-goal parent guard)
test("bare-goal parent (no milestone, no milestoneId) throws InvalidParentError", () => {
  assert.throws(
    () => assertValidParent("[[../goals/acquisition-research-engine]] — correctness fix.", {}),
    (e: unknown) => {
      assert.ok(e instanceof InvalidParentError, `expected InvalidParentError, got ${e}`);
      assert.match((e as Error).message, /acquisition-research-engine/);
      assert.match((e as Error).message, /mandate/);
      return true;
    },
  );
});

test("bare-goal parent is ALLOWED when a milestoneId is bound (goal-bound spec)", () => {
  assert.doesNotThrow(() =>
    assertValidParent("[[../goals/acquisition-research-engine]] — under M4.", { milestoneId: "abc-123" }),
  );
});

test("bare-goal parent is ALLOWED when the caller declares a typed mandate/milestone parent", () => {
  assert.doesNotThrow(() =>
    assertValidParent("[[../goals/acquisition-research-engine]]", { parentKind: "milestone" }),
  );
  assert.doesNotThrow(() =>
    assertValidParent("[[../goals/acquisition-research-engine]]", { parentKind: "mandate" }),
  );
});

test("milestone-anchored goal parent passes (names a specific milestone)", () => {
  assert.doesNotThrow(() =>
    assertValidParent("[[../goals/acquisition-research-engine#m4-hub]] — the hub milestone.", {}),
  );
  assert.doesNotThrow(() =>
    assertValidParent("[[../goals/acquisition-research-engine]] (M4) — the hub milestone.", {}),
  );
});

test("function-mandate parent passes (the one-off case)", () => {
  assert.doesNotThrow(() =>
    assertValidParent('[[../functions/platform]] — "Infra & DevOps / reliability" mandate: x.', {}),
  );
  // anchored form also passes
  assert.doesNotThrow(() => assertValidParent("[[../functions/platform#infra-devops-reliability]] — x.", {}));
});

// no-spec-parent — the strengthened guard catches every non-mandate/milestone shape
test("sibling-spec (../specs/) parent throws — a spec is never a parent", () => {
  assert.throws(
    () => assertValidParent("extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]]", {}),
    (e: unknown) => {
      assert.ok(e instanceof InvalidParentError);
      assert.match((e as Error).message, /sibling spec|never the parent|relatedSpec/i);
      return true;
    },
  );
});

test("free-text provenance parent throws (no wikilink)", () => {
  assert.throws(
    () => assertValidParent("a fix proposed by the DB Health Agent — surface-don't-apply.", {}),
    (e: unknown) => {
      assert.ok(e instanceof InvalidParentError);
      assert.match((e as Error).message, /free text|mandate or milestone|never a spec/i);
      return true;
    },
  );
});

test("bare-function parent (no mandate named) throws", () => {
  assert.throws(
    () => assertValidParent("[[../functions/platform]] — the platform-director graduates a fix.", {}),
    (e: unknown) => {
      assert.ok(e instanceof InvalidParentError);
      assert.match((e as Error).message, /not a specific mandate|## Mandates/i);
      return true;
    },
  );
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

// ── every-spec-writer-authors-machine-runnable-verifications Phase 1 — the CHOKEPOINT gate ──
// The single-chokepoint invariant: EVERY phase must yield >=1 check whose exec_kind is auto-testable
// AND passes `validateExecutableCheck`. A phase with only prose (needs_human) rows is REJECTED with
// MissingMachineCheckError so the deterministic runner has something concrete to execute — no writer
// can land a prose-only spec.

test("assertEveryPhaseHasMachineCheck throws MissingMachineCheckError when every check is needs_human (prose-only)", () => {
  assert.throws(
    () =>
      assertEveryPhaseHasMachineCheck("prose-only", [
        {
          title: "Wire it up",
          checks: [
            { position: 1, description: "look at the page", kind: "auto", exec_kind: "needs_human", params: null },
            { position: 2, description: "check the copy", kind: "auto", exec_kind: "needs_human", params: null },
          ],
        },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError, `expected MissingMachineCheckError, got ${e}`);
      assert.match((e as Error).message, /prose-only/);
      assert.match((e as Error).message, /phase 1 \(Wire it up\)/);
      assert.match((e as Error).message, /zero auto-testable checks/);
      return true;
    },
  );
});

test("assertEveryPhaseHasMachineCheck throws when checks carry only prose (undeclared exec_kind)", () => {
  assert.throws(
    () =>
      assertEveryPhaseHasMachineCheck("undeclared", [
        {
          title: "Prose bullets",
          checks: [{ position: 1, description: "verify the thing", kind: "auto" }],
        },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError);
      assert.match((e as Error).message, /no machine-runnable/);
      return true;
    },
  );
});

test("assertEveryPhaseHasMachineCheck passes with a single tsc check", () => {
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck("ok", [
      {
        title: "Migration + tsc",
        checks: [{ position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null }],
      },
    ]),
  );
});

test("assertEveryPhaseHasMachineCheck passes when needs_human rows COEXIST with a valid machine check", () => {
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck("mixed", [
      {
        title: "Machine + eyeball",
        checks: [
          {
            position: 1,
            description: "On the repo, grep for the new symbol",
            kind: "auto",
            exec_kind: "grep",
            params: { pattern: "assertEveryPhaseHasMachineCheck", expect: "present" },
          },
          {
            position: 2,
            description: "Founder eyeballs the /dashboard/roadmap card after ship",
            kind: "human",
            exec_kind: "needs_human",
            params: null,
          },
        ],
      },
    ]),
  );
});

test("assertEveryPhaseHasMachineCheck rejects grep with a malformed params.expect (invalid params → not machine-runnable)", () => {
  assert.throws(
    () =>
      assertEveryPhaseHasMachineCheck("bad-params", [
        {
          title: "Broken grep",
          checks: [
            {
              position: 1,
              description: "grep for X",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "foo", expect: "maybe" } as unknown as { pattern: string; expect: "present" | "absent" },
            },
          ],
        },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError);
      assert.match((e as Error).message, /grep.expect must be 'present' or 'absent'/);
      return true;
    },
  );
});

test("assertEveryPhaseHasMachineCheck names EVERY offending phase (multi-phase failure)", () => {
  assert.throws(
    () =>
      assertEveryPhaseHasMachineCheck("multi", [
        {
          title: "Good phase",
          checks: [{ position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null }],
        },
        {
          title: "Bad phase 2",
          checks: [
            { position: 1, description: "look at it", kind: "auto", exec_kind: "needs_human", params: null },
          ],
        },
        {
          title: "Bad phase 3",
          checks: [{ position: 1, description: "trust me", kind: "auto" }],
        },
      ]),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError);
      // First-good phase does not appear
      assert.doesNotMatch((e as Error).message, /phase 1 \(Good phase\)/);
      assert.match((e as Error).message, /phase 2 \(Bad phase 2\)/);
      assert.match((e as Error).message, /phase 3 \(Bad phase 3\)/);
      return true;
    },
  );
});

test("assertEveryPhaseHasMachineCheck respects packageScripts ctx for unit_test checks", () => {
  // A unit_test that names a script NOT in package.json is rejected AT AUTHORING — closes the
  // cs-director `npm test` class before it can land as an executable row.
  assert.throws(
    () =>
      assertEveryPhaseHasMachineCheck(
        "ctx-scripts",
        [
          {
            title: "Bogus unit test",
            checks: [
              {
                position: 1,
                description: "run the test",
                kind: "auto",
                exec_kind: "unit_test",
                params: { script: "test-that-does-not-exist" },
              },
            ],
          },
        ],
        { packageScripts: new Set(["test:unit", "check:types"]) },
      ),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError);
      assert.match((e as Error).message, /not a package.json script/);
      return true;
    },
  );
  // The same phase with a REAL script passes (belt-and-suspenders on the positive case).
  assert.doesNotThrow(() =>
    assertEveryPhaseHasMachineCheck(
      "ctx-scripts-ok",
      [
        {
          title: "Real unit test",
          checks: [
            {
              position: 1,
              description: "run the test",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:unit" },
            },
          ],
        },
      ],
      { packageScripts: new Set(["test:unit", "check:types"]) },
    ),
  );
});

test("assertEveryPhaseHasMachineCheck — a prose-only markdown blob (parseVerificationBlobToChecks → all needs_human) FAILS the gate", () => {
  // The markdown author path's shape: the parse is deterministic on prose (every bullet → needs_human).
  // Wiring this into the chokepoint means a markdown writer that carries only prose bullets is rejected
  // at author time, not silently landed as a set of un-executable rows.
  const blob = [
    "- On the page, look at the layout → confirm it reads right",
    "- On the roadmap, verify the intent header renders",
  ].join("\n");
  const derived = parseVerificationBlobToChecks(blob);
  assert.throws(
    () => assertEveryPhaseHasMachineCheck("prose-md", [{ title: "Prose phase", checks: derived }]),
    (e: unknown) => {
      assert.ok(e instanceof MissingMachineCheckError);
      assert.match((e as Error).message, /Phase 1/);
      return true;
    },
  );
});

// ── every-spec-writer-authors-machine-runnable-verifications Phase 2 — human_review advisory ──
// The OPTIONAL, non-blocking founder-facing note. Extracted from `**Human-review:**` on the
// markdown path; carried on `human_review` on the structured path; NEVER gates fold/promote/ship.
// The gates in `specs-table.computeUpsertAuthoringProblems` deliberately do NOT read this column —
// its presence or absence is invisible to the ship gate.

test("extractHumanReviewHeader pulls **Human-review:** from the markdown body", () => {
  const md = [
    "# Some spec",
    "",
    "**Owner:** [[../functions/growth]]",
    "**Human-review:** After ship, open /dashboard/ads/foo and confirm the funnel report reads right.",
    "",
    "## Phase 1 — do it",
  ].join("\n");
  const note = extractHumanReviewHeader(md);
  assert.ok(note, "expected the header to parse");
  assert.match(note!, /funnel report reads right/);
});

test("extractHumanReviewHeader returns null when the header is absent (absence is the norm)", () => {
  const md = "# Title\n\n**Owner:** platform\n\n## Phase 1 — do it";
  assert.equal(extractHumanReviewHeader(md), null);
});

test("computeUpsertAuthoringProblems IGNORES human_review — it never gates fold/ship/merge", () => {
  // A fully-authored spec with a human_review note + green machine checks reports ZERO problems.
  const problems = computeUpsertAuthoringProblems(
    { why: "spec why", what: "spec what" },
    [
      {
        position: 1,
        title: "P1",
        verification: "- On the branch, `npx tsc --noEmit` → expect clean.",
        why: "phase why",
        what: "phase what",
      },
    ],
    null,
    new Map(),
  );
  assert.deepEqual(problems, [], `expected no problems; got: ${problems.join(" | ")}`);
});

test("computeUpsertAuthoringProblems does NOT reference the human_review column at all", () => {
  // Belt-and-suspenders: even a totally-broken spec's problem list mentions verification/intent,
  // never human_review. Ensures the floor gate never gained an accidental reference to the new
  // non-blocking column.
  const problems = computeUpsertAuthoringProblems(
    { why: "", what: "" },
    [{ position: 1, title: "P1", verification: null, why: "", what: "" }],
    null,
    new Map(),
  );
  // Some problems are expected (empty why/what/verification), but NEVER one about human_review.
  assert.ok(problems.length > 0);
  for (const p of problems) {
    assert.doesNotMatch(p, /human[_-]?review/i, `unexpected human_review reference: ${p}`);
  }
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
  // machine-declared-verification Phase 1 — un-typed prose is stamped needs_human so the
  // deterministic runner never auto-runs a check whose params it did not receive.
  assert.equal(checks[0].exec_kind, "needs_human");
  assert.equal(checks[0].params, null);
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

// ── pm-structured-intent-and-refs Phase 1 round-trip verification ──
// Author-store-read round-trip proves the intent columns survive normalization + contain no code
// fences (the spec's Phase 1 verification bullet). Pure-function assertion — the wire "store" is
// modeled as an object literal since the DB write path is exercised in integration.

test("intent round-trips author→store→read unchanged and carries no code fences", () => {
  const specWhy =
    "The PM detail page is unreadable because the intent is buried in implementation prose.";
  const specWhat =
    "When this ships, every spec's detail page leads with a plain-language intent header.";
  // Gate accepts the fixture (the "author" step).
  assert.doesNotThrow(() =>
    assertEveryNodeHasIntent(
      "fixture",
      { why: specWhy, what: specWhat },
      [{ title: "P1", why: "phase why", what: "phase what" }],
    ),
  );
  // Modeled "store then read" — the SDK persists whitespace-normalized strings; a re-read yields
  // the same value byte-for-byte, and the lint would fail if a code fence sneaked in.
  const stored = { why: specWhy.trim(), what: specWhat.trim() };
  assert.equal(stored.why, specWhy.trim());
  assert.equal(stored.what, specWhat.trim());
  assert.doesNotThrow(() => assertIntentIsPlainLanguage("fixture", "why", stored.why));
  assert.doesNotThrow(() => assertIntentIsPlainLanguage("fixture", "what", stored.what));
  assert.equal(/```/.test(stored.why), false);
  assert.equal(/```/.test(stored.what), false);
});

// ── improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate Phase 2 ──────────────────
// The chokepoint SELF-CORRECTS a bare-function parent (matches `functions/{slug}` but no `#anchor`,
// no `mandate` keyword, no goal ref) by resolving the function's mandates and anchoring to the best-
// fit one instead of hard-failing the author. A function with zero mandates still throws (nothing to
// anchor to).

test("detectBareFunctionParent — bare `[[../functions/cs]]` is detected", () => {
  const r = detectBareFunctionParent("[[../functions/cs]]");
  assert.deepEqual(r, { functionSlug: "cs" });
});

test("detectBareFunctionParent — bracket-stripped `../functions/cs` (markdown-path shape) is also detected", () => {
  const r = detectBareFunctionParent("../functions/cs — some prose here");
  assert.deepEqual(r, { functionSlug: "cs" });
});

test("detectBareFunctionParent — a function reference WITH `#anchor` returns null (already anchored)", () => {
  assert.equal(detectBareFunctionParent("[[../functions/platform#infra-devops-reliability]] — x."), null);
});

test("detectBareFunctionParent — a function reference with the `mandate` keyword returns null (already anchored in prose)", () => {
  assert.equal(
    detectBareFunctionParent('[[../functions/platform]] — "Autonomous build platform" mandate: x.'),
    null,
  );
});

test("detectBareFunctionParent — a goal reference returns null (not a function parent at all)", () => {
  assert.equal(detectBareFunctionParent("[[../goals/acquisition-research-engine]]"), null);
});

test("detectBareFunctionParent — free text returns null", () => {
  assert.equal(detectBareFunctionParent("a fix proposed by the DB Health Agent"), null);
});

test("bestFitMandate — with a single mandate returns it", () => {
  const only: FunctionMandate = { slug: "only", heading: "Only mandate", body: "does the thing" };
  assert.equal(bestFitMandate([only], { title: "unrelated", why: "u", what: "u" }), only);
});

test("bestFitMandate — picks the mandate with the strongest distinct-term overlap", () => {
  const ms: FunctionMandate[] = [
    { slug: "a", heading: "Escalation triage quality", body: "adversarial quorum sweep of escalations" },
    { slug: "b", heading: "Fix weird tickets fast, calibrate", body: "reproduce the founder's terminal fix ticket chat and calibrate so they do not recur" },
    { slug: "c", heading: "Ticket-derived product fixes", body: "a code recommendation from a ticket becomes a ticket-sourced spec" },
  ];
  const best = bestFitMandate(ms, {
    title: "calibrate the analyzer so miscategorized dunning tickets stop recurring",
    why: "the analyzer rule fires on legitimate dunning failures — calibrate so they do not recur",
    what: "the calibrated rule stops mis-escalation",
  });
  assert.equal(best.slug, "b", `expected the calibration mandate (b), got ${best.slug}`);
});

test("bestFitMandate — ties fall back to the first mandate (declaration order in the charter)", () => {
  const ms: FunctionMandate[] = [
    { slug: "first", heading: "First", body: "" },
    { slug: "second", heading: "Second", body: "" },
  ];
  // no shared terms with either mandate → each score = 0 → the first mandate wins
  assert.equal(bestFitMandate(ms, { title: "unrelated words", why: "x", what: "y" }).slug, "first");
});

// ── The spec's Phase 2 verification bullet ────────────────────────────────────────────────────────
// "authoring a spec whose parent is the bare [[../functions/cs]] with a calibration-flavored why no
//  longer throws — it lands with parent_kind='mandate' and a parent_ref of the form cs#{mandate-slug}
//  that resolves to a real CS mandate; a bare function with zero mandates still throws
//  InvalidParentError."
// Tested at the deterministic helper layer (no DB): the helper is what the authorSpec* entry points
// call BEFORE assertValidParent to decide the anchor, and its output shape is exactly what the entry
// points then persist as `specs.parent` / `parent_kind` / `parent_ref`.

test("bare [[../functions/cs]] parent + calibration-flavored why auto-anchors to a real CS mandate — no longer throws", async () => {
  const result = await autoAnchorBareFunctionParent("[[../functions/cs]]", {
    title: "calibrate the ticket-analyzer to stop mis-escalating dunning failures",
    why:
      "we're mis-escalating dunning failures as customer tickets because the analyzer rule is too broad — " +
      "calibrate the rule so they do not recur.",
    what: "the analyzer skips the mis-categorized dunning path, escalations drop, calibration sticks.",
  });
  assert.ok(result, "expected the chokepoint to auto-anchor rather than return null");
  assert.equal(result!.parentKind, "mandate");
  assert.match(result!.parentRef, /^cs#[a-z0-9-]+$/, `parent_ref shape (got ${result!.parentRef})`);
  // parent prose is the canonical shape assertValidParent already accepts.
  assert.doesNotThrow(() => assertValidParent(result!.parent, { parentKind: result!.parentKind }));
  // The chosen mandate slug resolves back to a real CS mandate (not fabricated).
  const cs = await resolveFunctionMandates("cs");
  const found = cs.find((m) => `cs#${m.slug}` === result!.parentRef);
  assert.ok(
    found,
    `parent_ref ${result!.parentRef} did not resolve to a real CS mandate (available: ${cs.map((m) => `cs#${m.slug}`).join(", ")})`,
  );
});

test("bare function with ZERO mandates returns null → caller's assertValidParent still throws InvalidParentError", async () => {
  const r = await autoAnchorBareFunctionParent("[[../functions/this-function-does-not-exist]]", {
    title: "x", why: "y", what: "z",
  });
  assert.equal(r, null, "no mandates on the function → helper returns null so the caller can throw");
  // Prove the fallthrough: the caller re-runs assertValidParent on the ORIGINAL bare-function parent
  // and it STILL throws InvalidParentError (Phase 2's "keep the current InvalidParentError" rule).
  assert.throws(
    () => assertValidParent("[[../functions/this-function-does-not-exist]]", {}),
    (e: unknown) => e instanceof InvalidParentError,
  );
});

test("a NON bare-function parent (mandate-anchored already) is passed through unchanged (returns null)", async () => {
  const r = await autoAnchorBareFunctionParent(
    "[[../functions/platform#infra-devops-reliability]] — a proper anchored parent",
    { title: "x", why: "y", what: "z" },
  );
  assert.equal(r, null);
});
