// Vera harness-vs-assertion classifier (spec: vera-harness-error-is-not-a-code-regression Phase 1).
//
// A verification bullet whose command fails with a HARNESS/COMMAND signature — the command doesn't
// exist in the repo, an `npm` script is missing, a binary can't be found — is a BROKEN BULLET, not a
// code regression. It must NEVER be recorded as `verdict='fail'` (a `fail` spawns Bo's fix phase, and
// Bo can't build a phase that fixes a nonexistent shell command; the pipeline wedges — see the
// 2026-07-11 cs-director-leash false-regression that motivated this spec).
//
// Only a command that RAN and had an assertion FAIL is a real `fail`. Everything else classified as
// a "fail" by the agent gets re-routed to `needs_human` with the harness evidence, so the fix-phase
// authoring path (which filters on verdict === "fail") can never receive a harness-class check.
//
// This is a small, pure, side-effect-free library so the worker can call it in normalizeSpecTest and a
// unit test can drive it in isolation.

// The signatures we recognize as "the harness broke, not the code". Case-insensitive so the exact
// stderr string / evidence prose match either way.
const HARNESS_SIGNATURES: readonly RegExp[] = [
  // `npm error Missing script: "test"` — the exact motivating case: `npm test <file>` invoked in a
  // repo that only has `npm run test:<name>` scripts. Also matches the legacy `npm ERR!` prefix.
  /npm (?:error|err!) missing script/i,
  // Bash / sh / zsh "command not found". Also matches `bash: foo: command not found`, `/bin/sh: 1:
  // foo: not found`, and prose variants like "command was not found".
  /command not found/i,
  /:\s*not found\b/i,
  // A path passed to a runner that doesn't exist. `ENOENT` is Node's canonical form.
  /no such file or directory/i,
  /\benoent\b/i,
  // A binary that isn't installed / on PATH.
  /\bcannot find module\b/i,
  /\bcannot find package\b/i,
  // Common "you asked for a script that doesn't exist" phrasings from other package managers.
  /missing script:/i,
  /unknown command:/i,
];

// isHarnessCommandFailure — does this evidence string carry a HARNESS/COMMAND-failure signature?
// A `true` return means the "check" never actually ran an assertion — it broke at the shell before
// exercising code — so a `fail` verdict is a MISCLASSIFICATION.
export function isHarnessCommandFailure(evidence: string | null | undefined): boolean {
  if (!evidence) return false;
  return HARNESS_SIGNATURES.some((rx) => rx.test(evidence));
}

// A single spec-test check as the agent emits it — narrow enough for the classifier + wide enough
// that the worker's SpecTestCheck (with an optional category / screenshot) also satisfies it.
export interface HarnessCheckLike {
  text?: string;
  verdict: string;
  category?: string;
  evidence?: string;
  screenshot?: string;
}

export interface HarnessReclassifyResult<T extends HarnessCheckLike> {
  checks: T[];
  // Number of checks whose verdict was downgraded from `fail` to `needs_human`.
  reclassified: number;
}

// ── pre-merge-fix-skip-external-test-regressions-not-in-spec-diff Phase 1 ─────────────────────────
//
// A pre-merge spec-test unit_test failure whose failing test file is NOT in the build branch's diff
// vs main is an EXTERNAL regression — not this spec's fault — and must not append a Fix phase to the
// origin. Media-buyer-digest was shipped/correct but declared a unit_test on agent.test.ts (a file
// the digest spec doesn't own); an unrelated change transiently broke that test, stranding the
// shipped digest spec behind a redundant Fix N. Filter it out the same way harness failures are
// filtered — see isHarnessCommandFailure above.
//
// Pure + side-effect-free: the classifier takes ALREADY-RESOLVED `packageScripts` + `touchedFiles`
// so the fs/git work happens in the caller (best-effort, degrade to no-filter) and the unit test
// can drive it with hand-authored fixtures.

/**
 * Repo-relative test file paths a package.json `script` command runs. A tokenizer scan across the
 * command string keeps positional tokens whose path ends with a test extension we recognize:
 * `.test.{ts,tsx,mts,cts,js,jsx,mjs}`. Runners we've seen (`tsx --test`, `node --test`, `vitest`,
 * `jest`, `mocha`) all pass file args positionally; flags start with `-`.
 */
export function resolveUnitTestFilesFromScript(scriptCommand: string): string[] {
  if (!scriptCommand) return [];
  const tokens = scriptCommand
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  const files = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    if (/\.test\.(?:tsx?|mts|cts|jsx?|mjs)$/.test(t)) files.add(t.replace(/^\.\//, ""));
  }
  return [...files];
}

export interface ExternalTestRegressionInput {
  exec_kind?: string | null;
  script?: string | null;
}
export interface ExternalTestRegressionResult {
  external: boolean;
  testFiles: string[];
  reason: string;
}

/**
 * Is this failing check a unit_test regression that lives OUTSIDE the branch's diff?
 * Returns `external:true` only when:
 *  - the check is an `exec_kind='unit_test'` with a resolvable script name
 *  - `packageScripts` maps that script to a command
 *  - the command's positional test file(s) are ALL absent from `touchedFiles`
 * Every other case (unknown kind, missing script, no resolvable test files, at least one test file
 * touched by the branch) returns `external:false` — the caller preserves today's behaviour and
 * appends a Fix phase.
 */
export function isExternalTestRegression(
  check: ExternalTestRegressionInput,
  touchedFiles: ReadonlySet<string>,
  packageScripts: Readonly<Record<string, string>>,
): ExternalTestRegressionResult {
  if ((check.exec_kind ?? null) !== "unit_test") {
    return { external: false, testFiles: [], reason: "not a unit_test check" };
  }
  const script = (check.script ?? "").trim();
  if (!script) return { external: false, testFiles: [], reason: "no script name on check" };
  const cmd = packageScripts[script];
  if (!cmd) return { external: false, testFiles: [], reason: `package.json has no script "${script}"` };
  const testFiles = resolveUnitTestFilesFromScript(cmd);
  if (testFiles.length === 0) {
    return { external: false, testFiles: [], reason: `script "${script}" runs no resolvable test files` };
  }
  const touched = testFiles.filter((f) => touchedFiles.has(f));
  if (touched.length > 0) {
    return { external: false, testFiles, reason: `test file(s) in branch diff: ${touched.join(", ")}` };
  }
  return { external: true, testFiles, reason: `test file(s) NOT in branch diff: ${testFiles.join(", ")}` };
}

// reclassifyHarnessFails — walk a checks array and downgrade any `fail` whose evidence looks like a
// HARNESS/COMMAND failure to `needs_human` (category `needs_human`) with a note prefixed onto the
// evidence explaining WHY it was downgraded. Non-fail checks and fails with real breakage evidence
// are returned untouched. Belt-and-suspenders behind the prompt/skill teaching — even if Vera slips
// and emits a harness `fail`, the worker's normalizer strips it before it can spawn a Bo fix phase.
export function reclassifyHarnessFails<T extends HarnessCheckLike>(input: T[]): HarnessReclassifyResult<T> {
  let reclassified = 0;
  const checks = input.map((c) => {
    if (c.verdict !== "fail") return c;
    if (!isHarnessCommandFailure(c.evidence)) return c;
    reclassified += 1;
    const note = "harness/command failure (verification-authoring wart, not a code regression) — the command never ran an assertion; classified needs-human. Original evidence: ";
    const nextEvidence = (c.evidence ?? "").startsWith(note) ? c.evidence : `${note}${c.evidence ?? ""}`;
    return {
      ...c,
      verdict: "needs_human",
      category: "needs_human",
      evidence: nextEvidence,
    };
  });
  return { checks, reclassified };
}
