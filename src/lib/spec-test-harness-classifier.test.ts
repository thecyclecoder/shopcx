/**
 * vera-harness-error-is-not-a-code-regression Phase 1 — pin the exact wrong state that motivated
 * the spec: the 2026-07-11 `cs-director-leash-categories` false-regression, where Vera ran
 * `npm test src/lib/agents/cs-director.test.ts` in a repo that only has `npm run test:cs-director`,
 * got `npm error Missing script: "test"`, and stamped `verdict='fail'`. That mis-classified
 * `fail` spawned an unbuildable Bo fix phase and wedged the pipeline.
 *
 * The correct state: the reclassifier RECOGNIZES the harness signature, downgrades the check to
 * `needs_human`, and prefixes the evidence with a note explaining why. A genuine assertion-`fail`
 * with real breakage evidence remains a `fail` — the fix-phase authoring path (which filters on
 * verdict === "fail") still fires for real regressions.
 *
 * Run:
 *   npx tsx --test src/lib/spec-test-harness-classifier.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isHarnessCommandFailure,
  isExternalTestRegression,
  reclassifyHarnessFails,
  resolveUnitTestFilesFromScript,
} from "./spec-test-harness-classifier";

test("isHarnessCommandFailure recognizes the exact cs-director-leash motivating stderr", () => {
  const evidence = `Ran \`npm test src/lib/agents/cs-director.test.ts\`.\nnpm error Missing script: "test"\nnpm error To see a list of scripts, run: npm run\nExit code: 1`;
  assert.equal(isHarnessCommandFailure(evidence), true);
});

test("isHarnessCommandFailure recognizes command-not-found / ENOENT / Cannot find module", () => {
  assert.equal(isHarnessCommandFailure("bash: rg: command not found"), true);
  assert.equal(isHarnessCommandFailure("Error: ENOENT: no such file or directory, open '/x'"), true);
  assert.equal(isHarnessCommandFailure("node: Cannot find module '/nope.js'"), true);
  assert.equal(isHarnessCommandFailure("/bin/sh: 1: pnpm: not found"), true);
});

test("isHarnessCommandFailure does NOT match a real assertion failure", () => {
  // Real breakage evidence: the test ran and asserted the wrong value. This is a legitimate `fail`.
  const real = `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n"active" !== "canceled"\n  at test.ok (src/lib/foo.test.ts:42:3)`;
  assert.equal(isHarnessCommandFailure(real), false);
});

test("isHarnessCommandFailure handles empty / null / undefined evidence", () => {
  assert.equal(isHarnessCommandFailure(""), false);
  assert.equal(isHarnessCommandFailure(null), false);
  assert.equal(isHarnessCommandFailure(undefined), false);
});

// ── The named failing state the spec pins ───────────────────────────────────────────────────────

test("a `fail` check with the missing-npm-script signature is DOWNGRADED to needs_human", () => {
  const input = [
    {
      text: "the test file passes: npm test src/lib/agents/cs-director.test.ts",
      verdict: "fail",
      category: "auto",
      evidence: `npm error Missing script: "test"\nExit code: 1`,
    },
  ];
  const { checks, reclassified } = reclassifyHarnessFails(input);
  assert.equal(reclassified, 1, "the harness fail must be reclassified exactly once");
  assert.equal(checks[0].verdict, "needs_human", "harness/command failure is NEVER a code fail");
  assert.equal(checks[0].category, "needs_human", "category follows the verdict downgrade");
  assert.match(
    checks[0].evidence ?? "",
    /harness\/command failure/i,
    "reclassified evidence carries the diagnostic note so the owner sees why",
  );
  assert.match(
    checks[0].evidence ?? "",
    /Missing script/,
    "original harness stderr is preserved as evidence",
  );
});

test("a real assertion `fail` STAYS a fail (Bo's fix path still fires for genuine regressions)", () => {
  const input = [
    {
      text: "the resolver returns 'active' for a live subscription",
      verdict: "fail",
      category: "auto",
      evidence: `AssertionError: "active" !== "canceled" at src/lib/foo.test.ts:42:3`,
    },
  ];
  const { checks, reclassified } = reclassifyHarnessFails(input);
  assert.equal(reclassified, 0);
  assert.equal(checks[0].verdict, "fail", "real code regressions still produce a fail verdict");
});

test("pass / needs_human / inconclusive checks pass through untouched", () => {
  const input = [
    { text: "route exists", verdict: "pass", category: "auto", evidence: "src/app/foo/route.ts:1" },
    { text: "page looks good", verdict: "needs_human", category: "needs_human", evidence: "visual" },
    { text: "ambiguous bullet", verdict: "inconclusive", evidence: "n/a" },
  ];
  const { checks, reclassified } = reclassifyHarnessFails(input);
  assert.equal(reclassified, 0);
  assert.deepEqual(
    checks.map((c) => c.verdict),
    ["pass", "needs_human", "inconclusive"],
  );
});

test("a mixed run downgrades ONLY harness fails, leaving real fails as regressions", () => {
  const input = [
    {
      text: "test file passes",
      verdict: "fail",
      evidence: `npm error Missing script: "test"`,
    },
    {
      text: "route returns 200",
      verdict: "fail",
      evidence: "GET /api/foo → 500 Internal Server Error (real breakage observed)",
    },
    { text: "column present", verdict: "pass", evidence: "db-probe returned column" },
  ];
  const { checks, reclassified } = reclassifyHarnessFails(input);
  assert.equal(reclassified, 1, "one harness fail downgraded");
  assert.equal(checks[0].verdict, "needs_human");
  assert.equal(checks[1].verdict, "fail", "real 500 breakage stays a fail");
  assert.equal(checks[2].verdict, "pass");
});

// ── pre-merge-fix-skip-external-test-regressions-not-in-spec-diff Phase 1 ───────────────────────
//
// The named failing state the spec pins: a unit_test failure whose failing test file the build
// branch never touched must classify as EXTERNAL (drop from Fix-append set); a unit_test failure
// whose test file IS in the branch diff stays NON-external (append Fix as today). These are the
// exact (a) / (b) cases the spec's Phase-1 verification requires.

test("resolveUnitTestFilesFromScript pulls positional .test.ts args from a tsx --test command", () => {
  assert.deepEqual(
    resolveUnitTestFilesFromScript("tsx --test src/lib/media-buyer/agent.test.ts"),
    ["src/lib/media-buyer/agent.test.ts"],
  );
  // Multiple files + a leading ./ that gets normalized away.
  assert.deepEqual(
    resolveUnitTestFilesFromScript("tsx --test ./src/a.test.ts src/b.test.tsx"),
    ["src/a.test.ts", "src/b.test.tsx"],
  );
  // Flags never leak into the file list.
  assert.deepEqual(
    resolveUnitTestFilesFromScript("node --test --experimental-vm-modules src/foo.test.mjs"),
    ["src/foo.test.mjs"],
  );
  // Empty / no test files → empty set.
  assert.deepEqual(resolveUnitTestFilesFromScript(""), []);
  assert.deepEqual(resolveUnitTestFilesFromScript("npm run build"), []);
});

test("isExternalTestRegression: unit_test failure whose test file IS in the branch diff is NOT external", () => {
  // Case (a) from the spec's verification: a unit_test whose test file appears in `touchedFiles`
  // means the failing spec DID touch the code under test → this is a real regression → append Fix.
  const touched = new Set<string>(["src/lib/media-buyer/agent.ts", "src/lib/media-buyer/agent.test.ts"]);
  const pkgScripts = { "test:media-buyer-agent": "tsx --test src/lib/media-buyer/agent.test.ts" };
  const out = isExternalTestRegression(
    { exec_kind: "unit_test", script: "test:media-buyer-agent" },
    touched,
    pkgScripts,
  );
  assert.equal(out.external, false, "test file lives in the branch diff → this IS the spec's regression, not external");
  assert.deepEqual(out.testFiles, ["src/lib/media-buyer/agent.test.ts"]);
  assert.match(out.reason, /in branch diff/i);
});

test("isExternalTestRegression: unit_test failure whose test file is NOT in the branch diff IS external", () => {
  // Case (b) from the spec's verification: the exact media-buyer-digest incident cited in § Why —
  // the digest spec declared `test:media-buyer-agent` (a test in agent.test.ts, a file the digest
  // spec doesn't own); an unrelated change transiently broke that test; the shipped digest spec
  // must NOT be stranded by a Fix N for someone else's regression.
  const touched = new Set<string>(["src/app/api/digest/route.ts", "src/lib/media-buyer/digest.ts"]);
  const pkgScripts = { "test:media-buyer-agent": "tsx --test src/lib/media-buyer/agent.test.ts" };
  const out = isExternalTestRegression(
    { exec_kind: "unit_test", script: "test:media-buyer-agent" },
    touched,
    pkgScripts,
  );
  assert.equal(out.external, true, "test file is outside the branch diff → external, drop it");
  assert.deepEqual(out.testFiles, ["src/lib/media-buyer/agent.test.ts"]);
  assert.match(out.reason, /NOT in branch diff/i);
});

test("isExternalTestRegression: non-unit_test / unresolvable script / no test files → NOT external (append as today)", () => {
  const touched = new Set<string>();
  // Non-unit_test check → never external (harness has other filters).
  assert.equal(
    isExternalTestRegression({ exec_kind: "grep", script: null }, touched, {}).external,
    false,
  );
  // exec_kind unit_test but no script name → can't resolve → don't drop.
  assert.equal(
    isExternalTestRegression({ exec_kind: "unit_test", script: "" }, touched, {}).external,
    false,
  );
  // Script name absent from package.json → don't drop.
  assert.equal(
    isExternalTestRegression({ exec_kind: "unit_test", script: "unknown" }, touched, {}).external,
    false,
  );
  // Script command with no *.test.* args → don't drop (nothing to classify).
  assert.equal(
    isExternalTestRegression(
      { exec_kind: "unit_test", script: "build" },
      touched,
      { build: "next build" },
    ).external,
    false,
  );
});

test("reclassifying twice is idempotent (the note is not double-prefixed)", () => {
  const input = [
    {
      text: "test file passes",
      verdict: "fail",
      evidence: `npm error Missing script: "test"`,
    },
  ];
  const once = reclassifyHarnessFails(input);
  const twice = reclassifyHarnessFails(once.checks);
  assert.equal(twice.reclassified, 0, "already-needs_human check is not re-touched");
  assert.equal(twice.checks[0].evidence, once.checks[0].evidence);
});
