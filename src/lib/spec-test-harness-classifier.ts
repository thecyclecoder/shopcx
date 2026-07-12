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
